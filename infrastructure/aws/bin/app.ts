#!/usr/bin/env tsx
/**
 * CDK entrypoint for the Synapse Vault runtime on AWS.
 *
 * Reads vault configuration from env vars or context so the same stack
 * deploys one runtime per vault. Spin up multiple stacks by changing
 * SYNAPSE_AGENT_ID + STACK_SUFFIX between `cdk deploy` calls.
 */

import { App } from 'aws-cdk-lib';
import { VaultRuntimeStack } from '../lib/vault-runtime-stack.ts';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const stackSuffix = app.node.tryGetContext('stackSuffix') ?? process.env.STACK_SUFFIX;
const agentId =
  app.node.tryGetContext('agentId') ?? process.env.SYNAPSE_AGENT_ID;
const packageId =
  app.node.tryGetContext('packageId') ?? process.env.SYNAPSE_PACKAGE_ID;
const tickIntervalMinutes = Number(
  app.node.tryGetContext('tickIntervalMinutes') ??
    process.env.SYNAPSE_TICK_INTERVAL_MINUTES ??
    10,
);
const sessionSecretName =
  app.node.tryGetContext('sessionSecretName') ??
  process.env.SESSION_SECRET_NAME ??
  null;
const memwalSecretName =
  app.node.tryGetContext('memwalSecretName') ??
  process.env.MEMWAL_SECRET_NAME ??
  null;
const packageHistory =
  app.node.tryGetContext('packageHistory') ?? process.env.SYNAPSE_PACKAGE_HISTORY ?? null;
const anthropicSecretName =
  app.node.tryGetContext('anthropicSecretName') ?? process.env.ANTHROPIC_SECRET_NAME ?? null;
const enclaveUrl = app.node.tryGetContext('enclaveUrl') ?? process.env.SYNAPSE_ENCLAVE_URL ?? null;
const enclaveObjectId =
  app.node.tryGetContext('enclaveObjectId') ?? process.env.SYNAPSE_ENCLAVE_OBJECT_ID ?? null;
const crossAgentPeerVaultIds =
  app.node.tryGetContext('crossAgentPeerVaultIds') ??
  process.env.SYNAPSE_CROSS_AGENT_PEERS ??
  null;
const runtimeImageUri =
  app.node.tryGetContext('runtimeImageUri') ??
  process.env.SYNAPSE_RUNTIME_ECR_IMAGE ??
  process.env.SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE ??
  null;

if (!agentId || !packageId) {
  throw new Error(
    'Both SYNAPSE_AGENT_ID and SYNAPSE_PACKAGE_ID are required. ' +
      'Set them via env or `cdk deploy -c agentId=… -c packageId=…`.',
  );
}

const suffix = stackSuffix ? `-${stackSuffix}` : `-${agentId.slice(2, 10)}`;

new VaultRuntimeStack(app, `SynapseVaultRuntime${suffix}`, {
  env: { account, region },
  description: `Synapse Vault runtime for agent ${agentId}`,
  agentId,
  packageId,
  tickIntervalMinutes,
  sessionSecretName,
  memwalSecretName,
  packageHistory,
  anthropicSecretName,
  enclaveUrl,
  enclaveObjectId,
  crossAgentPeerVaultIds,
  runtimeImageUri,
});
