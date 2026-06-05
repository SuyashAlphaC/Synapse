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
}

export interface EnableHostedRuntimeRequest {
  vaultId: string;
  /** Full JSON contents of the dashboard `.key` file. */
  sessionKeyFileJson: string;
  /** Required for LLM / LangGraph marketplace strategies. */
  anthropicApiKey?: string;
  tickIntervalMinutes?: number;
  /** Must be true — confirms secrets are sent to Synapse AWS hosting. */
  consent: boolean;
}

export interface EnableHostedRuntimeResult {
  vaultId: string;
  stackName: string;
  phase: 'provisioning';
  message: string;
}
