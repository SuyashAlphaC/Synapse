import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTaskDefinitionsCommand,
} from '@aws-sdk/client-ecs';
import {
  DescribeRuleCommand,
  DisableRuleCommand,
  EnableRuleCommand,
  EventBridgeClient,
  ListRulesCommand,
} from '@aws-sdk/client-eventbridge';
import {
  sharedSynapseEnclaveDefaults,
  defaultPackageId,
  defaultTickIntervalMinutes,
  hostedRuntimePaths,
  hostedRuntimeRegion,
  isHostedRuntimeApiEnabled,
  isVercelDeployment,
  logGroupForVault,
  normalizeEnclaveObjectId,
  normalizeEnclaveUrl,
  packageHistoryCsv,
  secretNamesForVault,
  sharedRuntimeImageUri,
  stackNameForVault,
  useCloudFormationProvisioner,
  vaultShortId,
} from './config';
import { describeSecretExists, upsertAnthropicSecret, upsertVaultSecrets } from './secrets';
import type {
  EnableHostedRuntimeRequest,
  EnableHostedRuntimeResult,
  HostedRuntimeStatus,
  UpdateHostedRuntimeConfigRequest,
  UpdateHostedRuntimeCoordinationRequest,
} from './types';
import { assertVaultId, parseSessionKeyFileJson } from './parse-key';
import { deployVaultRuntimeStack } from './cfn-deploy';
import {
  normalizeCrossAgentPeerVaultIds,
  splitCrossAgentPeerVaultIds,
} from './cross-agent-peers';

function cfnClient(): CloudFormationClient {
  return new CloudFormationClient({ region: hostedRuntimeRegion() });
}

function mapStackPhase(status: string | undefined): HostedRuntimeStatus['phase'] {
  switch (status) {
    case 'CREATE_COMPLETE':
    case 'UPDATE_COMPLETE':
      return 'live';
    case 'CREATE_IN_PROGRESS':
    case 'UPDATE_IN_PROGRESS':
    case 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS':
      return 'provisioning';
    case 'CREATE_FAILED':
    case 'ROLLBACK_IN_PROGRESS':
    case 'ROLLBACK_COMPLETE':
    case 'ROLLBACK_FAILED':
    case 'UPDATE_ROLLBACK_IN_PROGRESS':
    case 'UPDATE_ROLLBACK_COMPLETE':
    case 'UPDATE_ROLLBACK_FAILED':
      return 'failed';
    default:
      return 'not_provisioned';
  }
}

function ecsClient(): ECSClient {
  return new ECSClient({ region: hostedRuntimeRegion() });
}

async function readLatestTaskEnvironment(
  vaultShortId: string,
): Promise<Record<string, string>> {
  try {
    const family = `SynapseVaultRuntime-${vaultShortId}`;
    const listed = await ecsClient().send(
      new ListTaskDefinitionsCommand({
        familyPrefix: family,
        sort: 'DESC',
        maxResults: 1,
      }),
    );
    const arn = listed.taskDefinitionArns?.[0];
    if (!arn) return {};
    const td = await ecsClient().send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
    const env = td.taskDefinition?.containerDefinitions?.[0]?.environment ?? [];
    const out: Record<string, string> = {};
    for (const entry of env) {
      if (entry.name && entry.value) out[entry.name] = entry.value;
    }
    return out;
  } catch {
    return {};
  }
}

async function isAttestationConfiguredOnTask(vaultShortId: string): Promise<boolean> {
  const env = await readLatestTaskEnvironment(vaultShortId);
  return Boolean(env.SYNAPSE_ENCLAVE_URL && env.SYNAPSE_ENCLAVE_OBJECT_ID);
}

async function readCrossAgentPeersFromTask(vaultShortId: string): Promise<string[]> {
  const env = await readLatestTaskEnvironment(vaultShortId);
  return splitCrossAgentPeerVaultIds(env.SYNAPSE_CROSS_AGENT_PEERS);
}

function resolveCrossAgentPeersInput(
  raw: string | undefined,
  vaultId: string,
): string | null {
  return normalizeCrossAgentPeerVaultIds(raw, { selfVaultId: vaultId });
}

function assertMemwalForCrossAgent(
  crossAgentPeerVaultIds: string | null,
  memwalDelegateHex: string | null,
  memwalSecretExists: boolean,
): void {
  if (!crossAgentPeerVaultIds) return;
  if (!memwalDelegateHex && !memwalSecretExists) {
    throw new Error(
      'Cross-agent reads require MemWal — mint with MemWal enabled and upload a .key file that includes memwalDelegate',
    );
  }
}

function resolveEnclaveConfigFromFields(body: {
  enclaveUrl?: string;
  enclaveObjectId?: string;
  requiresAttestation?: boolean;
}): {
  enclaveUrl: string | null;
  enclaveObjectId: string | null;
} {
  let enclaveUrl = normalizeEnclaveUrl(body.enclaveUrl);
  let enclaveObjectId = body.enclaveObjectId
    ? normalizeEnclaveObjectId(body.enclaveObjectId)
    : null;

  if (body.requiresAttestation && (!enclaveUrl || !enclaveObjectId)) {
    const shared = sharedSynapseEnclaveDefaults();
    enclaveUrl = enclaveUrl ?? shared.url;
    enclaveObjectId = enclaveObjectId ?? shared.objectId;
  }

  if (body.requiresAttestation && (!enclaveUrl || !enclaveObjectId)) {
    throw new Error(
      'Nautilus enclave URL and object ID are required when vault policy requires attestation',
    );
  }
  if ((enclaveUrl && !enclaveObjectId) || (!enclaveUrl && enclaveObjectId)) {
    throw new Error('Provide both enclave URL and enclave object ID, or leave both empty');
  }
  if (enclaveUrl && !/^https?:\/\//i.test(enclaveUrl)) {
    throw new Error('enclaveUrl must start with http:// or https://');
  }

  return { enclaveUrl, enclaveObjectId };
}

function resolveEnclaveConfig(body: EnableHostedRuntimeRequest): {
  enclaveUrl: string | null;
  enclaveObjectId: string | null;
} {
  return resolveEnclaveConfigFromFields(body);
}

async function findTickScheduleRule(vaultId: string): Promise<{ name: string; enabled: boolean } | null> {
  const client = new EventBridgeClient({ region: hostedRuntimeRegion() });
  const needle = vaultId.toLowerCase();
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new ListRulesCommand({
        NamePrefix: 'SynapseVaultRuntime-',
        NextToken: nextToken,
      }),
    );
    for (const rule of page.Rules ?? []) {
      if (!rule.Name) continue;
      const desc = rule.Description ?? '';
      if (desc.includes(vaultId) || desc.toLowerCase().includes(needle)) {
        const detail = await client.send(new DescribeRuleCommand({ Name: rule.Name }));
        return { name: rule.Name, enabled: detail.State === 'ENABLED' };
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return null;
}

export async function getHostedRuntimeStatus(vaultId: string): Promise<HostedRuntimeStatus> {
  assertVaultId(vaultId);
  const stackName = stackNameForVault(vaultId);
  const tickIntervalMinutes = defaultTickIntervalMinutes();

  const shortId = vaultShortId(vaultId);

  if (!isHostedRuntimeApiEnabled()) {
    return {
      enabled: false,
      vaultId,
      stackName,
      shortId,
      phase: 'not_configured',
      cloudFormationStatus: null,
      cloudFormationReason: null,
      logGroupName: logGroupForVault(vaultId),
      tickIntervalMinutes,
      scheduleEnabled: null,
      secretsReady: { session: false, memwal: false, anthropic: false },
      attestationConfigured: false,
      crossAgentConfigured: false,
      crossAgentPeerVaultIds: [],
    };
  }
  const names = secretNamesForVault(vaultId);

  const [sessionOk, memwalOk, anthropicOk] = await Promise.all([
    describeSecretExists(names.session),
    describeSecretExists(names.memwal),
    describeSecretExists(names.anthropic),
  ]);

  let cloudFormationStatus: string | null = null;
  let cloudFormationReason: string | null = null;
  let phase: HostedRuntimeStatus['phase'] = sessionOk ? 'not_provisioned' : 'not_provisioned';

  try {
    const stacks = await cfnClient().send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = stacks.Stacks?.[0];
    cloudFormationStatus = stack?.StackStatus ?? null;
    cloudFormationReason = stack?.StackStatusReason ?? null;
    phase = mapStackPhase(cloudFormationStatus ?? undefined);
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== 'ValidationError') throw err;
    phase = sessionOk ? 'not_provisioned' : 'not_provisioned';
  }

  const schedule = phase === 'live' || phase === 'provisioning' ? await findTickScheduleRule(vaultId) : null;
  if (phase === 'live' && schedule && !schedule.enabled) {
    phase = 'paused';
  }

  const attestationConfigured =
    phase === 'live' || phase === 'paused' || phase === 'provisioning'
      ? await isAttestationConfiguredOnTask(shortId)
      : false;
  const crossAgentPeerVaultIds =
    phase === 'live' || phase === 'paused' || phase === 'provisioning'
      ? await readCrossAgentPeersFromTask(shortId)
      : [];

  return {
    enabled: true,
    vaultId,
    stackName,
    shortId,
    phase,
    cloudFormationStatus,
    cloudFormationReason,
    logGroupName: logGroupForVault(vaultId),
    tickIntervalMinutes,
    scheduleEnabled: schedule?.enabled ?? null,
    secretsReady: {
      session: sessionOk,
      memwal: memwalOk,
      anthropic: anthropicOk,
    },
    attestationConfigured,
    crossAgentConfigured: crossAgentPeerVaultIds.length > 0,
    crossAgentPeerVaultIds,
  };
}

function logDeployOutput(vaultId: string, line: string): void {
  try {
    const dir = join(hostedRuntimePaths().repoRoot, '.synapse-hosted-runtime-logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${vaultShortId(vaultId)}.log`), `${line}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

function spawnCdkDeploy(args: {
  vaultId: string;
  tickIntervalMinutes: number;
  anthropicConfigured: boolean;
  memwalConfigured: boolean;
  enclaveUrl: string | null;
  enclaveObjectId: string | null;
  crossAgentPeerVaultIds: string | null;
}): void {
  const { awsDir } = hostedRuntimePaths();
  const names = secretNamesForVault(args.vaultId);
  const imageUri = sharedRuntimeImageUri();
  const cdkArgs = [
    'cdk',
    'deploy',
    '--require-approval',
    'never',
    '-c',
    `agentId=${args.vaultId}`,
    '-c',
    `packageId=${defaultPackageId()}`,
    '-c',
    `packageHistory=${packageHistoryCsv()}`,
    '-c',
    `sessionSecretName=${names.session}`,
    '-c',
    `tickIntervalMinutes=${args.tickIntervalMinutes}`,
  ];
  if (args.memwalConfigured) {
    cdkArgs.push('-c', `memwalSecretName=${names.memwal}`);
  }
  if (args.anthropicConfigured) {
    cdkArgs.push('-c', `anthropicSecretName=${names.anthropic}`);
  }
  if (imageUri) {
    cdkArgs.push('-c', `runtimeImageUri=${imageUri}`);
  }
  if (args.enclaveUrl) {
    cdkArgs.push('-c', `enclaveUrl=${args.enclaveUrl}`);
  }
  if (args.enclaveObjectId) {
    cdkArgs.push('-c', `enclaveObjectId=${args.enclaveObjectId}`);
  }
  if (args.crossAgentPeerVaultIds) {
    cdkArgs.push('-c', `crossAgentPeerVaultIds=${args.crossAgentPeerVaultIds}`);
  }

  const child = spawn('npx', cdkArgs, {
    cwd: awsDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AWS_REGION: hostedRuntimeRegion(),
      AWS_DEFAULT_REGION: hostedRuntimeRegion(),
    },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    logDeployOutput(args.vaultId, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    logDeployOutput(args.vaultId, chunk.toString('utf8'));
  });
  child.unref();
}

export async function enableHostedRuntime(
  body: EnableHostedRuntimeRequest,
): Promise<EnableHostedRuntimeResult> {
  if (!isHostedRuntimeApiEnabled()) {
    throw new Error('Synapse hosted runtime API is disabled on this dashboard server');
  }
  assertVaultId(body.vaultId);
  if (!body.consent) {
    throw new Error('consent must be true to enable Synapse-hosted runtime');
  }
  if (!body.sessionKeyFileJson || body.sessionKeyFileJson.length > 64 * 1024) {
    throw new Error('sessionKeyFileJson required (max 64 KiB)');
  }

  const parsed = parseSessionKeyFileJson(body.sessionKeyFileJson);
  const tickIntervalMinutes = body.tickIntervalMinutes ?? defaultTickIntervalMinutes();
  if (tickIntervalMinutes < 1 || tickIntervalMinutes > 60) {
    throw new Error('tickIntervalMinutes must be between 1 and 60');
  }

  const anthropic = body.anthropicApiKey?.trim() ?? null;
  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    throw new Error('anthropicApiKey must start with sk-ant-');
  }

  const { enclaveUrl, enclaveObjectId } = resolveEnclaveConfig(body);
  const crossAgentPeerVaultIds = resolveCrossAgentPeersInput(
    body.crossAgentPeerVaultIds,
    body.vaultId,
  );

  await upsertVaultSecrets({
    vaultId: body.vaultId,
    secretBase64: parsed.secretBase64,
    memwalDelegateHex: parsed.memwalDelegateHex,
    anthropicApiKey: anthropic,
  });

  assertMemwalForCrossAgent(
    crossAgentPeerVaultIds,
    parsed.memwalDelegateHex,
    false,
  );

  const names = secretNamesForVault(body.vaultId);
  const imageUri = sharedRuntimeImageUri();

  if (useCloudFormationProvisioner()) {
    if (!imageUri) {
      throw new Error(
        'SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE is required on Vercel (and recommended everywhere). ' +
          'Deploy one vault via CDK locally, then copy the ECR image URI from the task definition.',
      );
    }
    await deployVaultRuntimeStack({
      vaultId: body.vaultId,
      vaultShortId: vaultShortId(body.vaultId),
      packageId: defaultPackageId(),
      packageHistory: packageHistoryCsv(),
      sessionSecretName: names.session,
      memwalSecretName: parsed.memwalDelegateHex ? names.memwal : null,
      anthropicSecretName: anthropic ? names.anthropic : null,
      tickIntervalMinutes,
      runtimeImageUri: imageUri,
      enclaveUrl,
      enclaveObjectId,
      crossAgentPeerVaultIds,
    });
  } else {
    spawnCdkDeploy({
      vaultId: body.vaultId,
      tickIntervalMinutes,
      anthropicConfigured: Boolean(anthropic),
      memwalConfigured: Boolean(parsed.memwalDelegateHex),
      enclaveUrl,
      enclaveObjectId,
      crossAgentPeerVaultIds,
    });
  }

  const attestationNote =
    enclaveUrl && enclaveObjectId
      ? ' Nautilus attestation configured — every tick will call the enclave.'
      : '';
  const crossAgentNote = crossAgentPeerVaultIds
    ? ' MemWal cross-agent peers configured.'
    : '';

  return {
    vaultId: body.vaultId,
    stackName: stackNameForVault(body.vaultId),
    phase: 'provisioning',
    message: `${provisioningMessage(imageUri)}${attestationNote}${crossAgentNote}`,
  };
}

function provisioningMessage(imageUri: string | null): string {
  if (useCloudFormationProvisioner()) {
    return isVercelDeployment()
      ? 'Secrets stored. CloudFormation stack provisioning on AWS (typically 2–4 min).'
      : 'Secrets stored. CloudFormation stack update started (typically 2–4 min).';
  }
  return imageUri
    ? 'Secrets stored. Deploying Fargate stack with shared runtime image (typically 2–4 min).'
    : 'Secrets stored. Deploying Fargate stack (Docker build — typically 5–10 min on first vault). Set SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE for faster enables.';
}

export async function updateHostedRuntimeConfig(
  body: UpdateHostedRuntimeConfigRequest,
): Promise<EnableHostedRuntimeResult> {
  if (!isHostedRuntimeApiEnabled()) {
    throw new Error('Synapse hosted runtime API is disabled on this dashboard server');
  }
  assertVaultId(body.vaultId);

  const status = await getHostedRuntimeStatus(body.vaultId);
  if (status.phase === 'not_provisioned' || status.phase === 'not_configured') {
    throw new Error('Hosted runtime is not provisioned — use Enable hosted runtime first');
  }
  if (status.phase === 'provisioning') {
    throw new Error('Stack update already in progress — wait for provisioning to finish');
  }

  const { enclaveUrl, enclaveObjectId } = resolveEnclaveConfigFromFields({
    enclaveUrl: body.enclaveUrl,
    enclaveObjectId: body.enclaveObjectId,
  });
  if (!enclaveUrl || !enclaveObjectId) {
    throw new Error('enclaveUrl and enclaveObjectId are required');
  }

  const anthropic = body.anthropicApiKey?.trim() ?? null;
  if (anthropic && !anthropic.startsWith('sk-ant-')) {
    throw new Error('anthropicApiKey must start with sk-ant-');
  }
  if (anthropic) {
    await upsertAnthropicSecret(body.vaultId, anthropic);
  }

  const names = secretNamesForVault(body.vaultId);
  const [memwalOk, anthropicOk] = await Promise.all([
    describeSecretExists(names.memwal),
    describeSecretExists(names.anthropic),
  ]);
  const imageUri = sharedRuntimeImageUri();
  if (!imageUri) {
    throw new Error('SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE is required');
  }

  await deployVaultRuntimeStack({
    vaultId: body.vaultId,
    vaultShortId: vaultShortId(body.vaultId),
    packageId: defaultPackageId(),
    packageHistory: packageHistoryCsv(),
    sessionSecretName: names.session,
    memwalSecretName: memwalOk ? names.memwal : null,
    anthropicSecretName: anthropic || anthropicOk ? names.anthropic : null,
    tickIntervalMinutes: status.tickIntervalMinutes,
    runtimeImageUri: imageUri,
    enclaveUrl,
    enclaveObjectId,
    crossAgentPeerVaultIds:
      normalizeCrossAgentPeerVaultIds(
        (await readCrossAgentPeersFromTask(vaultShortId(body.vaultId))).join(','),
        { selfVaultId: body.vaultId },
      ) ?? null,
  });

  return {
    vaultId: body.vaultId,
    stackName: stackNameForVault(body.vaultId),
    phase: 'provisioning',
    message:
      'Nautilus enclave config applied — CloudFormation stack update started (typically 2–4 min). Resume ticks when live.',
  };
}

export async function updateHostedRuntimeCoordination(
  body: UpdateHostedRuntimeCoordinationRequest,
): Promise<EnableHostedRuntimeResult> {
  if (!isHostedRuntimeApiEnabled()) {
    throw new Error('Synapse hosted runtime API is disabled on this dashboard server');
  }
  assertVaultId(body.vaultId);

  const status = await getHostedRuntimeStatus(body.vaultId);
  if (status.phase === 'not_provisioned' || status.phase === 'not_configured') {
    throw new Error('Hosted runtime is not provisioned — use Enable hosted runtime first');
  }
  if (status.phase === 'provisioning') {
    throw new Error('Stack update already in progress — wait for provisioning to finish');
  }

  const crossAgentPeerVaultIds = resolveCrossAgentPeersInput(
    body.crossAgentPeerVaultIds,
    body.vaultId,
  );

  const names = secretNamesForVault(body.vaultId);
  const [memwalOk, anthropicOk] = await Promise.all([
    describeSecretExists(names.memwal),
    describeSecretExists(names.anthropic),
  ]);
  assertMemwalForCrossAgent(crossAgentPeerVaultIds, null, memwalOk);

  const shortId = vaultShortId(body.vaultId);
  const taskEnv = await readLatestTaskEnvironment(shortId);
  const enclaveUrl = taskEnv.SYNAPSE_ENCLAVE_URL ?? null;
  const enclaveObjectId = taskEnv.SYNAPSE_ENCLAVE_OBJECT_ID ?? null;

  const imageUri = sharedRuntimeImageUri();
  if (!imageUri) {
    throw new Error('SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE is required');
  }

  await deployVaultRuntimeStack({
    vaultId: body.vaultId,
    vaultShortId: shortId,
    packageId: defaultPackageId(),
    packageHistory: packageHistoryCsv(),
    sessionSecretName: names.session,
    memwalSecretName: memwalOk ? names.memwal : null,
    anthropicSecretName: anthropicOk ? names.anthropic : null,
    tickIntervalMinutes: status.tickIntervalMinutes,
    runtimeImageUri: imageUri,
    enclaveUrl,
    enclaveObjectId,
    crossAgentPeerVaultIds,
  });

  const peerNote = crossAgentPeerVaultIds
    ? ' Cross-agent peers updated on the Fargate task.'
    : ' Cross-agent peers cleared on the Fargate task.';

  return {
    vaultId: body.vaultId,
    stackName: stackNameForVault(body.vaultId),
    phase: 'provisioning',
    message: `Coordination config applied — CloudFormation stack update started (typically 2–4 min).${peerNote}`,
  };
}

export async function setHostedRuntimePaused(vaultId: string, paused: boolean): Promise<void> {
  if (!isHostedRuntimeApiEnabled()) {
    throw new Error('Synapse hosted runtime API is disabled on this dashboard server');
  }
  assertVaultId(vaultId);
  const rule = await findTickScheduleRule(vaultId);
  if (!rule) {
    throw new Error('No EventBridge schedule found for this vault — finish provisioning first');
  }
  const client = new EventBridgeClient({ region: hostedRuntimeRegion() });
  if (paused) {
    await client.send(new DisableRuleCommand({ Name: rule.name }));
  } else {
    await client.send(new EnableRuleCommand({ Name: rule.name }));
  }
}
