import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hostedRuntimeRegion, secretNamesForVault } from './config';

function client(): SecretsManagerClient {
  return new SecretsManagerClient({ region: hostedRuntimeRegion() });
}

async function upsertPlaintextSecret(args: {
  name: string;
  description: string;
  value: string;
}): Promise<void> {
  const sm = client();
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: args.name }));
    await sm.send(
      new PutSecretValueCommand({
        SecretId: args.name,
        SecretString: args.value,
      }),
    );
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code !== 'ResourceNotFoundException') throw err;
    await sm.send(
      new CreateSecretCommand({
        Name: args.name,
        Description: args.description,
        SecretString: args.value,
      }),
    );
  }
}

export async function upsertVaultSecrets(args: {
  vaultId: string;
  secretBase64: string;
  memwalDelegateHex: string | null;
  anthropicApiKey: string | null;
}): Promise<{ session: string; memwal: string | null; anthropic: string | null }> {
  const names = secretNamesForVault(args.vaultId);

  await upsertPlaintextSecret({
    name: names.session,
    description: `Synapse Vault session key for ${args.vaultId}`,
    value: args.secretBase64,
  });

  if (args.memwalDelegateHex) {
    await upsertPlaintextSecret({
      name: names.memwal,
      description: `Synapse Vault MemWal delegate for ${args.vaultId}`,
      value: args.memwalDelegateHex,
    });
  }

  if (args.anthropicApiKey) {
    await upsertPlaintextSecret({
      name: names.anthropic,
      description: `Synapse Vault Anthropic API key for ${args.vaultId}`,
      value: args.anthropicApiKey.trim(),
    });
  }

  return {
    session: names.session,
    memwal: args.memwalDelegateHex ? names.memwal : null,
    anthropic: args.anthropicApiKey ? names.anthropic : null,
  };
}

export async function describeSecretExists(name: string): Promise<boolean> {
  const sm = client();
  try {
    await sm.send(new DescribeSecretCommand({ SecretId: name }));
    return true;
  } catch {
    return false;
  }
}
