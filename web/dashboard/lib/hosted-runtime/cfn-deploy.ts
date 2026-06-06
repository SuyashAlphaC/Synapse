import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  type StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import { buildVaultRuntimeTemplate, type VaultRuntimeStackSpec } from './cfn-template';
import {
  defaultWalrusNetwork,
  hostedRuntimeRegion,
  stackNameForVault,
} from './config';

const IN_PROGRESS: StackStatus[] = [
  'CREATE_IN_PROGRESS',
  'UPDATE_IN_PROGRESS',
  'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
  'ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_IN_PROGRESS',
];

export interface DeployVaultRuntimeArgs {
  vaultId: string;
  vaultShortId: string;
  packageId: string;
  packageHistory: string;
  sessionSecretName: string;
  memwalSecretName: string | null;
  anthropicSecretName: string | null;
  tickIntervalMinutes: number;
  runtimeImageUri: string;
  enclaveUrl?: string | null;
  enclaveObjectId?: string | null;
  crossAgentPeerVaultIds?: string | null;
}

function cfnClient(): CloudFormationClient {
  return new CloudFormationClient({ region: hostedRuntimeRegion() });
}

function ec2Client(): EC2Client {
  return new EC2Client({ region: hostedRuntimeRegion() });
}

async function resolveNetwork(): Promise<{ vpcId: string; subnetIds: string[] }> {
  const vpcOverride = process.env.SYNAPSE_HOSTED_RUNTIME_VPC_ID?.trim();
  const subnetOverride = process.env.SYNAPSE_HOSTED_RUNTIME_SUBNET_IDS?.trim();
  if (vpcOverride && subnetOverride) {
    return {
      vpcId: vpcOverride,
      subnetIds: subnetOverride.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  const vpcs = await ec2Client().send(
    new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }),
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error(
      'No default VPC found. Set SYNAPSE_HOSTED_RUNTIME_VPC_ID and SYNAPSE_HOSTED_RUNTIME_SUBNET_IDS.',
    );
  }

  const subnets = await ec2Client().send(
    new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'map-public-ip-on-launch', Values: ['true'] },
      ],
    }),
  );
  const subnetIds = (subnets.Subnets ?? [])
    .map((s) => s.SubnetId)
    .filter((id): id is string => Boolean(id));
  if (subnetIds.length === 0) {
    throw new Error(
      `No public subnets in VPC ${vpcId}. Set SYNAPSE_HOSTED_RUNTIME_SUBNET_IDS.`,
    );
  }
  return { vpcId, subnetIds };
}

async function stackExists(stackName: string): Promise<boolean> {
  try {
    await cfnClient().send(new DescribeStacksCommand({ StackName: stackName }));
    return true;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === 'ValidationError') return false;
    throw err;
  }
}

async function assertStackNotBusy(stackName: string): Promise<void> {
  const stacks = await cfnClient().send(new DescribeStacksCommand({ StackName: stackName }));
  const status = stacks.Stacks?.[0]?.StackStatus;
  if (status && IN_PROGRESS.includes(status)) {
    throw new Error(`Stack ${stackName} is busy (${status}) — wait and retry`);
  }
}

/**
 * Deploy or update a vault runtime stack via CloudFormation API.
 * Works on Vercel serverless (no CDK CLI, no Docker).
 */
export async function deployVaultRuntimeStack(args: DeployVaultRuntimeArgs): Promise<void> {
  const region = hostedRuntimeRegion();
  const { vpcId, subnetIds } = await resolveNetwork();
  const spec: VaultRuntimeStackSpec = {
    agentId: args.vaultId,
    vaultShortId: args.vaultShortId,
    packageId: args.packageId,
    packageHistory: args.packageHistory,
    sessionSecretName: args.sessionSecretName,
    memwalSecretName: args.memwalSecretName,
    anthropicSecretName: args.anthropicSecretName,
    tickIntervalMinutes: args.tickIntervalMinutes,
    runtimeImageUri: args.runtimeImageUri,
    walrusNetwork: defaultWalrusNetwork(),
    enclaveUrl: args.enclaveUrl ?? null,
    enclaveObjectId: args.enclaveObjectId ?? null,
    crossAgentPeerVaultIds: args.crossAgentPeerVaultIds ?? null,
    vpcId,
    subnetIds,
    awsRegion: region,
  };
  const templateBody = buildVaultRuntimeTemplate(spec);
  const stackName = stackNameForVault(args.vaultId);
  const capabilities = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'] as const;

  if (await stackExists(stackName)) {
    await assertStackNotBusy(stackName);
    try {
      await cfnClient().send(
        new UpdateStackCommand({
          StackName: stackName,
          TemplateBody: templateBody,
          Capabilities: [...capabilities],
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('No updates are to be performed')) {
        return;
      }
      throw err;
    }
    return;
  }

  await cfnClient().send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: templateBody,
      Capabilities: [...capabilities],
    }),
  );
}
