import { resolve } from 'node:path';
import {
  NETWORK,
  SYNAPSE_PACKAGE_HISTORY,
  SYNAPSE_PACKAGE_ID,
  SYNAPSE_TESTNET_ENCLAVE_OBJECT_ID,
  SYNAPSE_TESTNET_ENCLAVE_URL,
} from '@/lib/synapse-config';

export function isHostedRuntimeApiEnabled(): boolean {
  return process.env.SYNAPSE_HOSTED_RUNTIME_ENABLED === 'true';
}

/** True when running on Vercel (serverless — no CDK CLI or Docker). */
export function isVercelDeployment(): boolean {
  return process.env.VERCEL === '1';
}

/**
 * CloudFormation API deploy (Vercel-safe). On Vercel always; locally when
 * SYNAPSE_HOSTED_RUNTIME_USE_CFN=true or a shared ECR image is configured.
 */
export function useCloudFormationProvisioner(): boolean {
  if (isVercelDeployment()) return true;
  if (process.env.SYNAPSE_HOSTED_RUNTIME_USE_CFN === 'true') return true;
  return Boolean(sharedRuntimeImageUri());
}

export function hostedRuntimeRegion(): string {
  return (
    process.env.SYNAPSE_HOSTED_RUNTIME_AWS_REGION ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    'us-east-1'
  );
}

export function hostedRuntimePaths(): { repoRoot: string; awsDir: string } {
  const dashboardRoot = process.cwd();
  const repoRoot = resolve(dashboardRoot, '../..');
  const awsDir = resolve(repoRoot, 'infrastructure/aws');
  return { repoRoot, awsDir };
}

export function vaultShortId(vaultId: string): string {
  return vaultId.startsWith('0x') ? vaultId.slice(2, 10) : vaultId.slice(0, 8);
}

export function stackNameForVault(vaultId: string): string {
  return `SynapseVaultRuntime-${vaultShortId(vaultId)}`;
}

export function secretNamesForVault(vaultId: string): {
  session: string;
  memwal: string;
  anthropic: string;
} {
  const short = vaultShortId(vaultId);
  return {
    session: `synapse/vault/${short}/session-key`,
    memwal: `synapse/vault/${short}/memwal-delegate`,
    anthropic: `synapse/vault/${short}/anthropic-key`,
  };
}

export function logGroupForVault(vaultId: string): string {
  return `/synapse/vault/${vaultShortId(vaultId)}`;
}

export function packageHistoryCsv(): string {
  return SYNAPSE_PACKAGE_HISTORY.length > 0
    ? [...SYNAPSE_PACKAGE_HISTORY].join(',')
    : SYNAPSE_PACKAGE_ID;
}

export function defaultPackageId(): string {
  return process.env.SYNAPSE_HOSTED_RUNTIME_PACKAGE_ID ?? SYNAPSE_PACKAGE_ID;
}

export function defaultWalrusNetwork(): 'testnet' | 'mainnet' {
  return NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
}

export function sharedRuntimeImageUri(): string | null {
  const uri =
    process.env.SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE ??
    process.env.SYNAPSE_RUNTIME_ECR_IMAGE ??
    null;
  return uri && uri.trim().length > 0 ? uri.trim() : null;
}

export function defaultTickIntervalMinutes(): number {
  const raw = Number(process.env.SYNAPSE_HOSTED_RUNTIME_TICK_MINUTES ?? 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}

/** Dashboard-server override for Nautilus enclave HTTP base URL. */
export function defaultEnclaveUrl(): string | null {
  const url =
    process.env.SYNAPSE_HOSTED_RUNTIME_ENCLAVE_URL ??
    process.env.SYNAPSE_ENCLAVE_URL ??
    null;
  if (!url || !url.trim()) return null;
  return url.trim().replace(/\/$/, '');
}

/** Dashboard-server override for registered `Enclave` object id. */
export function defaultEnclaveObjectId(): string | null {
  const raw =
    process.env.SYNAPSE_HOSTED_RUNTIME_ENCLAVE_OBJECT_ID ??
    process.env.SYNAPSE_ENCLAVE_OBJECT_ID ??
    process.env.NEXT_PUBLIC_SYNAPSE_ENCLAVE_OBJECT_ID ??
    null;
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/**
 * Synapse-operated shared enclave defaults (server env overrides, then testnet
 * constants). Used for UI prefills and server-side auto-resolution when a vault
 * requires attestation but the DAO did not supply custom enclave fields.
 */
export function sharedSynapseEnclaveDefaults(): {
  url: string | null;
  objectId: string | null;
} {
  const url =
    defaultEnclaveUrl() ??
    (NETWORK === 'testnet' ? SYNAPSE_TESTNET_ENCLAVE_URL.replace(/\/$/, '') : null);
  const objectId =
    defaultEnclaveObjectId() ??
    (NETWORK === 'testnet' ? SYNAPSE_TESTNET_ENCLAVE_OBJECT_ID : null);
  return { url, objectId };
}

export function synapseManagedEnclaveAvailable(): boolean {
  const { url, objectId } = sharedSynapseEnclaveDefaults();
  return Boolean(url && objectId);
}

export function normalizeEnclaveUrl(url: string | undefined | null): string | null {
  if (!url?.trim()) return null;
  return url.trim().replace(/\/$/, '');
}

export function normalizeEnclaveObjectId(id: string | undefined | null): string | null {
  if (!id?.trim()) return null;
  const trimmed = id.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`)) {
    throw new Error('enclaveObjectId must be a 32-byte hex object id (0x…)');
  }
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}
