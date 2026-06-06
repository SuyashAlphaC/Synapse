/**
 * Synapse Vault runtime stack.
 *
 * Provisions, in a single ECS Fargate scheduled task per vault:
 *   - ECR image built from sdk/packages/vault/Dockerfile
 *   - ECS cluster + Fargate task definition (single replica, ephemeral)
 *   - Secrets Manager entries for the session keypair (required) and the
 *     MemWal delegate key (optional). The stack imports them by name —
 *     create the secrets manually first with infrastructure/aws/scripts/
 *     push-secrets.sh
 *   - CloudWatch log group with 30-day retention for tick logs
 *   - EventBridge cron rule that runs the Fargate task once every N
 *     minutes (default 10) — that's the autonomous loop the agent ticks on
 *
 * Each `cdk deploy` invocation targets one vault. Run again with a
 * different agentId for additional vaults.
 */

import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export interface VaultRuntimeStackProps extends StackProps {
  agentId: string;
  packageId: string;
  tickIntervalMinutes: number;
  /** Name of the Secrets Manager secret holding the suiprivkey-formatted session secret. */
  sessionSecretName: string | null;
  /** Name of the Secrets Manager secret holding the MemWal delegate key hex. Optional. */
  memwalSecretName: string | null;
  /** Every historical package id, newest first (comma-separated). Optional; defaults to packageId. */
  packageHistory?: string | null;
  /** Secret holding the Anthropic API key — only for vaults hiring the llm-advisor. Optional. */
  anthropicSecretName?: string | null;
  /** Nautilus enclave URL — only for attested vaults (requires_attestation). Optional. */
  enclaveUrl?: string | null;
  /** On-chain `Enclave` object id — only for attested vaults. Optional. */
  enclaveObjectId?: string | null;
  /** Comma-separated peer vault ids for MemWal cross-agent reads (shared namespace). */
  crossAgentPeerVaultIds?: string | null;
  /**
   * When set, skip the per-stack Docker build and use this image URI
   * (shared ECR tag). Used by the dashboard hosted-runtime provisioner.
   */
  runtimeImageUri?: string | null;
}

export class VaultRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props: VaultRuntimeStackProps) {
    super(scope, id, props);

    if (!props.sessionSecretName) {
      throw new Error(
        'sessionSecretName is required. Create the secret first via push-secrets.sh.',
      );
    }

    // ---------- Container image ----------
    const containerImage = props.runtimeImageUri
      ? ecs.ContainerImage.fromRegistry(props.runtimeImageUri)
      : ecs.ContainerImage.fromDockerImageAsset(
          new DockerImageAsset(this, 'RuntimeImage', {
            directory: REPO_ROOT,
            file: 'sdk/packages/vault/Dockerfile',
            platform: Platform.LINUX_AMD64,
            // CDK stages the whole repo into cdk.out before `docker build`. Without
            // these excludes, a prior failed deploy's cdk.out is copied into itself
            // recursively → ENAMETOOLONG.
            exclude: [
              'infrastructure/aws/cdk.out',
              '**/cdk.out',
              '**/.git',
              '**/node_modules',
              'web/dashboard',
              'web/marketing',
              'infrastructure/aws/node_modules',
              'enclave',
              'move',
              'examples/messaging-demo',
              'examples/publish',
              'docs',
              '**/.next',
              '**/.turbo',
              '**/coverage',
            ],
          }),
        );

    // ---------- Network ----------
    // Default VPC keeps cost low and avoids NAT gateway charges for the
    // outbound RPC calls the runtime makes.
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // ---------- Cluster ----------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `synapse-vault-${props.agentId.slice(2, 10)}`,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    // ---------- Secrets ----------
    const sessionSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SessionSecret',
      props.sessionSecretName,
    );
    const memwalSecret = props.memwalSecretName
      ? secretsmanager.Secret.fromSecretNameV2(
          this,
          'MemWalSecret',
          props.memwalSecretName,
        )
      : null;
    const anthropicSecret = props.anthropicSecretName
      ? secretsmanager.Secret.fromSecretNameV2(
          this,
          'AnthropicSecret',
          props.anthropicSecretName,
        )
      : null;

    // ---------- Task ----------
    const logGroup = new logs.LogGroup(this, 'TickLogs', {
      logGroupName: `/synapse/vault/${props.agentId.slice(2, 10)}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TickTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDefinition.addContainer('Runtime', {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tick',
        logGroup,
      }),
      environment: {
        SYNAPSE_AGENT_ID: props.agentId,
        SYNAPSE_PACKAGE_ID: props.packageId,
        SYNAPSE_WALRUS_NETWORK: 'testnet',
        // Adaptive WAL refuel — sized for ~0.05 SUI session balances.
        SYNAPSE_WAL_REFUEL_AMOUNT: '50000000',
        SYNAPSE_WAL_REFUEL_THRESHOLD: '10000000',
        SYNAPSE_TICK_INTERVAL_MS: String(
          Math.max(60, props.tickIntervalMinutes * 60) * 1000,
        ),
        ...(props.packageHistory ? { SYNAPSE_PACKAGE_HISTORY: props.packageHistory } : {}),
        // Attested vaults (requires_attestation): the runtime calls this enclave
        // for a signed decision and gates the rebalance PTB on attest_decision.
        ...(props.enclaveUrl ? { SYNAPSE_ENCLAVE_URL: props.enclaveUrl } : {}),
        ...(props.enclaveObjectId ? { SYNAPSE_ENCLAVE_OBJECT_ID: props.enclaveObjectId } : {}),
        SYNAPSE_MESSAGING_BRIDGE_PATH: '/app/examples/messaging-runtime-bridge/dist/rpc.js',
        ...(props.crossAgentPeerVaultIds
          ? { SYNAPSE_CROSS_AGENT_PEERS: props.crossAgentPeerVaultIds }
          : {}),
      },
      secrets: {
        SYNAPSE_SESSION_KEY: ecs.Secret.fromSecretsManager(sessionSecret),
        ...(memwalSecret
          ? { MEMWAL_DELEGATE_KEY: ecs.Secret.fromSecretsManager(memwalSecret) }
          : {}),
        // Per-vault Anthropic key (llm-advisor). EnvSecretsProvider reads
        // ANTHROPIC_API_KEY; injected from Secrets Manager so it never lands in
        // the task definition in plaintext.
        ...(anthropicSecret
          ? { ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicSecret) }
          : {}),
      },
      command: ['--once'],
    });
    void container;

    // Grant read on the secrets (CDK already attaches a base policy via
    // Secret.fromSecretNameV2 + secrets parameter, but make the intent
    // explicit so a hand-edit doesn't break it).
    sessionSecret.grantRead(taskDefinition.taskRole);
    memwalSecret?.grantRead(taskDefinition.taskRole);
    anthropicSecret?.grantRead(taskDefinition.taskRole);

    // Shared ECR images (hosted runtime / runtimeImageUri) are not CDK assets —
    // the execution role must pull them explicitly.
    if (props.runtimeImageUri) {
      taskDefinition.addToExecutionRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
      );
      taskDefinition.addToExecutionRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
          ],
          resources: ['*'],
        }),
      );
    }

    // ---------- EventBridge cron ----------
    new events.Rule(this, 'TickSchedule', {
      schedule: events.Schedule.rate(
        Duration.minutes(Math.max(1, props.tickIntervalMinutes)),
      ),
      targets: [
        new eventsTargets.EcsTask({
          cluster,
          taskDefinition,
          taskCount: 1,
          // Public subnet with no NAT, so a public IP is REQUIRED for outbound
          // egress (RPC / Walrus / MemWal). The task still accepts no inbound —
          // the default security group has no ingress rules. For a fully private
          // task, switch to PRIVATE_WITH_EGRESS + a NAT gateway and set this false.
          assignPublicIp: true,
          subnetSelection: { subnetType: ec2.SubnetType.PUBLIC },
        }),
      ],
      description: `Run Synapse Vault tick every ${props.tickIntervalMinutes} min for ${props.agentId}`,
    });

    void ecsPatterns;
  }
}
