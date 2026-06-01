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
}

export class VaultRuntimeStack extends Stack {
  constructor(scope: Construct, id: string, props: VaultRuntimeStackProps) {
    super(scope, id, props);

    if (!props.sessionSecretName) {
      throw new Error(
        'sessionSecretName is required. Create the secret first via push-secrets.sh.',
      );
    }

    // ---------- Image build ----------
    const image = new DockerImageAsset(this, 'RuntimeImage', {
      directory: REPO_ROOT,
      file: 'sdk/packages/vault/Dockerfile',
      platform: Platform.LINUX_AMD64,
    });

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
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'tick',
        logGroup,
      }),
      environment: {
        SYNAPSE_AGENT_ID: props.agentId,
        SYNAPSE_PACKAGE_ID: props.packageId,
        SYNAPSE_WALRUS_NETWORK: 'testnet',
        SYNAPSE_TICK_INTERVAL_MS: String(
          Math.max(60, props.tickIntervalMinutes * 60) * 1000,
        ),
      },
      secrets: {
        SYNAPSE_SESSION_KEY: ecs.Secret.fromSecretsManager(sessionSecret),
        ...(memwalSecret
          ? { MEMWAL_DELEGATE_KEY: ecs.Secret.fromSecretsManager(memwalSecret) }
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

    void ecsPatterns; // imported for IDE/type assistance; not used directly
    void iam;
  }
}
