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
  /** True when SYNAPSE_CROSS_AGENT_PEERS is set on the Fargate task definition. */
  crossAgentConfigured: boolean;
  /** True when MemWal delegate secret is on the task (writer publishes to shared namespace). */
  crossAgentPublishingConfigured: boolean;
  /** Peer vault ids configured on the hosted runtime task (empty when unset). */
  crossAgentPeerVaultIds: string[];
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
  /**
   * Comma- or newline-separated peer vault object ids for MemWal cross-agent
   * reads (`SYNAPSE_CROSS_AGENT_PEERS`). Requires MemWal delegate in the .key file.
   */
  crossAgentPeerVaultIds?: string;
}

export interface UpdateHostedRuntimeConfigRequest {
  vaultId: string;
  enclaveUrl: string;
  enclaveObjectId: string;
  /** When set, replaces the vault's Anthropic secret in Secrets Manager. */
  anthropicApiKey?: string;
}

export interface UpdateHostedRuntimeCoordinationRequest {
  vaultId: string;
  /** Empty string clears cross-agent peers on the stack. */
  crossAgentPeerVaultIds: string;
}

export interface EnableHostedRuntimeResult {
  vaultId: string;
  stackName: string;
  phase: 'provisioning';
  message: string;
}
