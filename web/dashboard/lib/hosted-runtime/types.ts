export type HostedRuntimePhase =
  | 'not_configured'
  | 'not_provisioned'
  | 'provisioning'
  | 'live'
  | 'failed'
  | 'paused';

export interface HostedRuntimeStatus {
  enabled: boolean;
  vaultId: string;
  stackName: string;
  shortId: string;
  phase: HostedRuntimePhase;
  cloudFormationStatus: string | null;
  cloudFormationReason: string | null;
  logGroupName: string;
  tickIntervalMinutes: number;
  scheduleEnabled: boolean | null;
  secretsReady: {
    session: boolean;
    memwal: boolean;
    anthropic: boolean;
  };
  /** True when the Fargate task definition includes SYNAPSE_ENCLAVE_* env vars. */
  attestationConfigured: boolean;
}

export interface EnableHostedRuntimeRequest {
  vaultId: string;
  /** Full JSON contents of the dashboard `.key` file. */
  sessionKeyFileJson: string;
  /** Optional — only for strategies that call Claude at tick time. */
  anthropicApiKey?: string;
  tickIntervalMinutes?: number;
  /** Nautilus enclave base URL (Oyster / dev). Falls back to server env defaults. */
  enclaveUrl?: string;
  /** Registered `Enclave` object id on-chain. Falls back to server env defaults. */
  enclaveObjectId?: string;
  /** When true, enclave URL + object id are required (vault policy gate is on). */
  requiresAttestation?: boolean;
  /** Must be true — confirms secrets are sent to Synapse AWS hosting. */
  consent: boolean;
}

export interface UpdateHostedRuntimeConfigRequest {
  vaultId: string;
  enclaveUrl: string;
  enclaveObjectId: string;
  /** When set, replaces the vault's Anthropic secret in Secrets Manager. */
  anthropicApiKey?: string;
}

export interface EnableHostedRuntimeResult {
  vaultId: string;
  stackName: string;
  phase: 'provisioning';
  message: string;
}
