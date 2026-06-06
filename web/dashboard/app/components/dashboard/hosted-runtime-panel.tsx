'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CodeTag } from '../ui/code-tag';
import { useToast } from '../ui/toast';
import type { HostedRuntimePhase, HostedRuntimeStatus } from '@/lib/hosted-runtime/types';

interface Props {
  vaultId: string;
  /** When true, surface Anthropic key field (LLM strategies that call Claude). */
  needsAnthropicKey?: boolean;
  /** When true, Nautilus enclave fields are required on enable. */
  requiresAttestation?: boolean;
}

interface PublicConfig {
  apiEnabled: boolean;
  region: string;
  sharedRuntimeImageConfigured: boolean;
  defaultTickIntervalMinutes: number;
  deployMode?: 'cloudformation' | 'cdk-local';
  vercel?: boolean;
  defaultEnclaveUrl?: string | null;
  defaultEnclaveObjectId?: string | null;
}

const TICK_OPTIONS = [5, 10, 15, 30] as const;

const PHASE_LABEL: Record<HostedRuntimePhase, string> = {
  not_configured: 'Not available',
  not_provisioned: 'Not enabled',
  provisioning: 'Provisioning…',
  live: 'Live on AWS',
  failed: 'Deploy failed',
  paused: 'Paused',
};

const PHASE_ACCENT: Record<HostedRuntimePhase, string> = {
  not_configured: 'var(--ink-mute)',
  not_provisioned: 'var(--accent-orange)',
  provisioning: 'var(--accent-blue)',
  live: 'var(--state-active)',
  failed: 'var(--accent-orange)',
  paused: 'var(--accent-yellow)',
};

/**
 * Self-serve Synapse-hosted Fargate runtime. Uploads session secrets to AWS
 * Secrets Manager and triggers CDK deploy via the dashboard provisioning API.
 */
export function HostedRuntimePanel({
  vaultId,
  needsAnthropicKey = false,
  requiresAttestation = false,
}: Props) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [keyFileText, setKeyFileText] = useState<string | null>(null);
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [enclaveUrl, setEnclaveUrl] = useState('');
  const [enclaveObjectId, setEnclaveObjectId] = useState('');
  const [tickMinutes, setTickMinutes] = useState(10);
  const [consent, setConsent] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [updatingEnclave, setUpdatingEnclave] = useState(false);
  const [pausing, setPausing] = useState(false);

  const configQuery = useQuery({
    queryKey: ['hosted-runtime-config'],
    staleTime: 60_000,
    queryFn: async (): Promise<PublicConfig> => {
      const res = await fetch('/api/hosted-runtime/config');
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as PublicConfig;
    },
  });

  useEffect(() => {
    if (configQuery.data?.defaultTickIntervalMinutes) {
      setTickMinutes(configQuery.data.defaultTickIntervalMinutes);
    }
  }, [configQuery.data?.defaultTickIntervalMinutes]);

  // Prefill enclave fields only when BOTH server defaults exist — a lone object
  // id (common on testnet) blocks enable with "Incomplete enclave config".
  useEffect(() => {
    const url = configQuery.data?.defaultEnclaveUrl;
    const id = configQuery.data?.defaultEnclaveObjectId;
    if (!url || !id) return;
    if (!enclaveUrl) setEnclaveUrl(url);
    if (!enclaveObjectId) setEnclaveObjectId(id);
  }, [
    configQuery.data?.defaultEnclaveObjectId,
    configQuery.data?.defaultEnclaveUrl,
    enclaveObjectId,
    enclaveUrl,
  ]);

  const statusQuery = useQuery({
    queryKey: ['hosted-runtime-status', vaultId],
    enabled: Boolean(configQuery.data?.apiEnabled),
    staleTime: 0,
    refetchInterval: (query) => {
      const phase = (query.state.data as HostedRuntimeStatus | undefined)?.phase;
      if (phase === 'provisioning') return 8_000;
      if (phase === 'live' || phase === 'paused') return 30_000;
      return 15_000;
    },
    queryFn: async (): Promise<HostedRuntimeStatus> => {
      const res = await fetch(
        `/api/hosted-runtime/status?vaultId=${encodeURIComponent(vaultId)}`,
      );
      const body = (await res.json()) as HostedRuntimeStatus | { error?: string };
      if (!res.ok) throw new Error('error' in body ? body.error : res.statusText);
      return body as HostedRuntimeStatus;
    },
  });

  const status = statusQuery.data;
  const phase = status?.phase ?? 'not_provisioned';
  const apiEnabled = configQuery.data?.apiEnabled ?? false;
  const isProvisioning = phase === 'provisioning';
  const showEnableForm =
    apiEnabled &&
    !isProvisioning &&
    (phase === 'not_provisioned' || phase === 'failed' || phase === 'not_configured');

  const showUpdateEnclaveForm =
    apiEnabled && !isProvisioning && (phase === 'live' || phase === 'paused');

  const onPickKeyFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith('.key') && !file.name.endsWith('.json')) {
        toast.push({
          variant: 'warn',
          title: 'Wrong file type',
          body: 'Expected the .key file from the mint wizard or session key panel.',
        });
        return;
      }
      if (file.size > 64 * 1024) {
        toast.push({ variant: 'warn', title: 'File too large', body: 'Max 64 KiB.' });
        return;
      }
      const text = await file.text();
      try {
        const parsed = JSON.parse(text) as { address?: unknown; secretBase64?: unknown };
        if (typeof parsed.address !== 'string' || typeof parsed.secretBase64 !== 'string') {
          throw new Error('missing address or secretBase64');
        }
      } catch (err) {
        toast.push({
          variant: 'danger',
          title: 'Not a valid .key file',
          body: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      setKeyFileText(text);
      setKeyFileName(file.name);
    },
    [toast],
  );

  const onEnable = useCallback(async () => {
    if (!keyFileText) {
      toast.push({ variant: 'warn', title: 'Upload your .key file first', body: '' });
      return;
    }
    if (!consent) {
      toast.push({
        variant: 'warn',
        title: 'Confirm hosting consent',
        body: 'Check the box to authorize Synapse to store secrets in AWS.',
      });
      return;
    }
    if (needsAnthropicKey && !anthropicKey.trim()) {
      toast.push({
        variant: 'warn',
        title: 'Anthropic API key required',
        body: 'This strategy calls Claude at tick time.',
      });
      return;
    }
    const resolvedEnclaveUrl = enclaveUrl.trim();
    const resolvedEnclaveObjectId = enclaveObjectId.trim();
    if (requiresAttestation && (!resolvedEnclaveUrl || !resolvedEnclaveObjectId)) {
      toast.push({
        variant: 'warn',
        title: 'Nautilus enclave required',
        body: 'Vault policy requires attestation — set enclave URL and object ID.',
      });
      return;
    }
    if (
      (resolvedEnclaveUrl && !resolvedEnclaveObjectId) ||
      (!resolvedEnclaveUrl && resolvedEnclaveObjectId)
    ) {
      toast.push({
        variant: 'warn',
        title: 'Incomplete enclave config',
        body: 'Provide both enclave URL and object ID, or leave both empty.',
      });
      return;
    }
    setEnabling(true);
    try {
      const res = await fetch('/api/hosted-runtime/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultId,
          sessionKeyFileJson: keyFileText,
          anthropicApiKey: anthropicKey.trim() || undefined,
          enclaveUrl: resolvedEnclaveUrl || undefined,
          enclaveObjectId: resolvedEnclaveObjectId || undefined,
          requiresAttestation,
          tickIntervalMinutes: tickMinutes,
          consent: true,
        }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      toast.push({
        variant: 'success',
        title: 'Hosted runtime provisioning',
        body: body.message ?? 'Deploy started — watch Runtime Health for ticks.',
        durationMs: 10_000,
      });
      setKeyFileText(null);
      setKeyFileName(null);
      setAnthropicKey('');
      setConsent(false);
      void queryClient.invalidateQueries({ queryKey: ['hosted-runtime-status', vaultId] });
      void queryClient.invalidateQueries({ queryKey: ['synapse-latest-tick', vaultId] });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Enable failed',
        body: err instanceof Error ? err.message : String(err),
        durationMs: 12_000,
      });
    } finally {
      setEnabling(false);
    }
  }, [
    anthropicKey,
    consent,
    enclaveObjectId,
    enclaveUrl,
    keyFileText,
    needsAnthropicKey,
    queryClient,
    requiresAttestation,
    tickMinutes,
    toast,
    vaultId,
  ]);

  const onUpdateEnclaveConfig = useCallback(async () => {
    const resolvedEnclaveUrl = enclaveUrl.trim();
    const resolvedEnclaveObjectId = enclaveObjectId.trim();
    if (!resolvedEnclaveUrl || !resolvedEnclaveObjectId) {
      toast.push({
        variant: 'warn',
        title: 'Enclave URL and object ID required',
        body: 'Both fields are needed to configure Nautilus on an existing stack.',
      });
      return;
    }
    setUpdatingEnclave(true);
    try {
      const res = await fetch('/api/hosted-runtime/update-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultId,
          enclaveUrl: resolvedEnclaveUrl,
          enclaveObjectId: resolvedEnclaveObjectId,
          anthropicApiKey: anthropicKey.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      toast.push({
        variant: 'success',
        title: 'Nautilus config updating',
        body: body.message ?? 'Stack update started — nautilus ✓ after UPDATE_COMPLETE.',
        durationMs: 10_000,
      });
      setAnthropicKey('');
      void queryClient.invalidateQueries({ queryKey: ['hosted-runtime-status', vaultId] });
    } catch (err) {
      toast.push({
        variant: 'danger',
        title: 'Update failed',
        body: err instanceof Error ? err.message : String(err),
        durationMs: 12_000,
      });
    } finally {
      setUpdatingEnclave(false);
    }
  }, [anthropicKey, enclaveObjectId, enclaveUrl, queryClient, toast, vaultId]);

  const onTogglePause = useCallback(
    async (paused: boolean) => {
      setPausing(true);
      try {
        const res = await fetch('/api/hosted-runtime/disable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultId, paused }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        toast.push({
          variant: 'info',
          title: paused ? 'Ticks paused' : 'Ticks resumed',
          body: paused
            ? 'EventBridge schedule disabled — no autonomous ticks until you resume.'
            : 'Schedule re-enabled.',
        });
        void queryClient.invalidateQueries({ queryKey: ['hosted-runtime-status', vaultId] });
      } catch (err) {
        toast.push({
          variant: 'danger',
          title: 'Schedule update failed',
          body: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setPausing(false);
      }
    },
    [queryClient, toast, vaultId],
  );

  return (
    <div className="card-flat p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-display text-2xl font-bold">Hosted runtime</h3>
        <CodeTag>{apiEnabled ? PHASE_LABEL[phase] : 'api off'}</CodeTag>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-ink-soft">
        Enable Synapse-managed AWS Fargate — no CLI, no{' '}
        <code className="font-mono text-[10px]">cdk deploy</code>. Upload your session{' '}
        <code className="font-mono text-[10px]">.key</code> once; we store secrets in AWS Secrets
        Manager and provision a per-vault tick schedule. Runtime Health above turns green when ticks
        land on-chain.
      </p>

      {!apiEnabled && !configQuery.isLoading && (
        <p className="rounded-sm border-l-2 border-ink-mute bg-paper p-3 font-mono text-[11px] text-ink-soft">
          Hosted runtime API is off. Set <code>SYNAPSE_HOSTED_RUNTIME_ENABLED=true</code> and AWS
          credentials in Vercel environment variables (or <code>.env.local</code> locally).
        </p>
      )}

      {apiEnabled && !configQuery.data?.sharedRuntimeImageConfigured && (
        <p className="mb-4 rounded-sm border-l-2 bg-paper p-3 font-mono text-[11px] text-ink-soft" style={{ borderColor: 'var(--accent-orange)' }}>
          Set <code>SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE</code> to a shared runtime Docker image URI
          (required on Vercel — one image serves all vaults). Build once via{' '}
          <code>cdk deploy</code> locally, then copy the image from the ECS task definition.
        </p>
      )}

      {apiEnabled && status && phase !== 'not_provisioned' && phase !== 'not_configured' && (
        <div
          className="mb-4 rounded-sm border-l-2 bg-paper p-3 font-mono text-[11px] text-ink-soft"
          style={{ borderColor: PHASE_ACCENT[phase] }}
        >
          <p>
            <strong className="text-ink">{PHASE_LABEL[phase]}</strong>
            {status.cloudFormationStatus ? ` · ${status.cloudFormationStatus}` : null}
          </p>
          {status.cloudFormationReason && (
            <p className="mt-1 text-state-danger">{status.cloudFormationReason}</p>
          )}
          <p className="mt-1">
            Stack <code>{status.stackName}</code> · logs{' '}
            <code>{status.logGroupName}</code>
            {status.scheduleEnabled !== null
              ? ` · schedule ${status.scheduleEnabled ? 'on' : 'off'}`
              : null}
          </p>
          <p className="mt-1">
            Secrets: session {status.secretsReady.session ? '✓' : '—'} · memwal{' '}
            {status.secretsReady.memwal ? '✓' : '—'} · anthropic{' '}
            {status.secretsReady.anthropic ? '✓' : '—'}
            {' · '}
            nautilus {status.attestationConfigured ? '✓' : '—'}
          </p>
        </div>
      )}

      {apiEnabled && (phase === 'live' || phase === 'paused') && (
        <div className="mb-4 flex flex-wrap gap-2">
          {phase === 'live' ? (
            <button
              type="button"
              className="btn-flat"
              data-variant="warn"
              disabled={pausing}
              onClick={() => void onTogglePause(true)}
            >
              {pausing ? 'Pausing…' : 'Pause ticks'}
            </button>
          ) : (
            <button
              type="button"
              className="btn-flat"
              data-variant="accent"
              disabled={pausing}
              onClick={() => void onTogglePause(false)}
            >
              {pausing ? 'Resuming…' : 'Resume ticks'}
            </button>
          )}
          <button
            type="button"
            className="font-mono text-[11px] text-ink-soft hover:text-ink"
            disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
          >
            {statusQuery.isFetching ? 'refreshing…' : 'refresh status'}
          </button>
        </div>
      )}

      {showUpdateEnclaveForm && (
        <div className="mb-4 grid gap-3 rounded-sm border border-divider bg-paper p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
            Configure Nautilus
            {status?.attestationConfigured ? ' · update enclave' : ' · not configured yet'}
          </p>
          <p className="text-[11px] leading-relaxed text-ink-soft">
            Your stack is already provisioned — use this form to set or change enclave URL and
            object ID (no need to re-upload the session .key). After{' '}
            <code className="font-mono text-[10px]">UPDATE_COMPLETE</code>, refresh status until{' '}
            <strong>nautilus ✓</strong>, then resume ticks.
          </p>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] text-ink-mute">Enclave URL</span>
            <input
              type="url"
              value={enclaveUrl}
              disabled={updatingEnclave}
              onChange={(e) => setEnclaveUrl(e.target.value)}
              placeholder="http://54.166.136.55:3000"
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            />
          </label>
          <label className="grid gap-1">
            <span className="font-mono text-[10px] text-ink-mute">Enclave object ID</span>
            <input
              type="text"
              value={enclaveObjectId}
              disabled={updatingEnclave}
              onChange={(e) => setEnclaveObjectId(e.target.value)}
              placeholder="0x2e170c44…"
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            />
          </label>
          {needsAnthropicKey && (
            <label className="grid gap-1">
              <span className="font-mono text-[10px] text-ink-mute">
                Anthropic API key (optional — only if changing)
              </span>
              <input
                type="password"
                autoComplete="off"
                value={anthropicKey}
                disabled={updatingEnclave}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder={status?.secretsReady.anthropic ? 'leave blank to keep existing' : 'sk-ant-…'}
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
            </label>
          )}
          <button
            type="button"
            className="btn-flat w-fit"
            data-variant="accent"
            disabled={updatingEnclave}
            onClick={() => void onUpdateEnclaveConfig()}
          >
            {updatingEnclave ? 'Updating…' : 'Apply Nautilus config'}
          </button>
        </div>
      )}

      {showEnableForm && apiEnabled && (
        <div className="grid gap-3">
          <label className="grid gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              Session .key file
            </span>
            <input
              type="file"
              accept=".key,.json,application/json"
              disabled={enabling}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPickKeyFile(f);
              }}
              className="block w-full text-xs file:mr-3 file:rounded-sm file:border file:border-ink file:bg-paper-strong file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-ink hover:file:bg-paper"
            />
            {keyFileName && (
              <span className="font-mono text-[10px] text-state-active">✓ {keyFileName}</span>
            )}
          </label>

          {needsAnthropicKey && (
            <label className="grid gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
                Anthropic API key
              </span>
              <p className="text-[11px] leading-relaxed text-ink-soft">
                Your vault&apos;s key — Claude usage bills to you, not Synapse. Stored in AWS
                Secrets Manager per vault and forwarded to the enclave on each attested tick.
              </p>
              <input
                type="password"
                autoComplete="off"
                value={anthropicKey}
                disabled={enabling}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-…"
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
            </label>
          )}

          <div className="grid gap-2 rounded-sm border border-divider bg-paper p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              Nautilus attestation
              {requiresAttestation ? ' · required by vault policy' : ' · optional'}
            </p>
            <p className="text-[11px] leading-relaxed text-ink-soft">
              {requiresAttestation
                ? 'Required by vault policy — provide a reachable enclave URL and registered on-chain Enclave object id.'
                : 'Optional — leave both fields empty to run without Nautilus (local strategy execution).'}
              {' '}
              When set, every tick calls the enclave and stamps{' '}
              <code className="font-mono text-[10px]">decision_attestation::attest_decision_v2</code>{' '}
              on-chain.
            </p>
            {!requiresAttestation && (enclaveUrl.trim() || enclaveObjectId.trim()) ? (
              <button
                type="button"
                disabled={enabling}
                onClick={() => {
                  setEnclaveUrl('');
                  setEnclaveObjectId('');
                }}
                className="w-fit font-mono text-[10px] uppercase tracking-[0.12em] text-accent-orange underline-offset-2 hover:underline"
              >
                Clear enclave fields (no Nautilus)
              </button>
            ) : null}
            <label className="grid gap-1">
              <span className="font-mono text-[10px] text-ink-mute">Enclave URL</span>
              <input
                type="url"
                value={enclaveUrl}
                disabled={enabling}
                onChange={(e) => setEnclaveUrl(e.target.value)}
                placeholder="https://…"
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[10px] text-ink-mute">Enclave object ID</span>
              <input
                type="text"
                value={enclaveObjectId}
                disabled={enabling}
                onChange={(e) => setEnclaveObjectId(e.target.value)}
                placeholder="0x…"
                className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
              />
            </label>
          </div>

          <label className="grid max-w-xs gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
              Tick interval (minutes)
            </span>
            <select
              value={tickMinutes}
              disabled={enabling}
              onChange={(e) => setTickMinutes(Number(e.target.value))}
              className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
            >
              {TICK_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-start gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={consent}
              disabled={enabling}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I authorize Synapse to store my session key
              {needsAnthropicKey ? ', MemWal delegate, and Anthropic API key' : ' and MemWal delegate'}{' '}
              in AWS Secrets Manager ({configQuery.data?.region ?? 'us-east-1'}) and run my strategy
              on Synapse-hosted Fargate until I pause or revoke the vault.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-flat"
              data-variant="accent"
              disabled={enabling || !keyFileText}
              onClick={() => void onEnable()}
            >
              {enabling
                ? 'Enabling…'
                : phase === 'failed'
                  ? 'Retry enable'
                  : 'Enable hosted runtime'}
            </button>
            {!configQuery.data?.sharedRuntimeImageConfigured && configQuery.data?.deployMode === 'cdk-local' && (
              <span className="font-mono text-[10px] text-ink-mute">
                Local mode can build Docker on first enable; Vercel requires{' '}
                SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE.
              </span>
            )}
          </div>
        </div>
      )}

      {isProvisioning && (
        <p className="mt-3 font-mono text-[11px] text-ink-mute">
          CDK deploy running in the background — status refreshes automatically. Check CloudWatch log
          group <code>{status?.logGroupName}</code> once the stack reaches CREATE_COMPLETE.
        </p>
      )}
    </div>
  );
}
