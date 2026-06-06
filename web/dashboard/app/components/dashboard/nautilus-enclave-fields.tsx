'use client';

interface SharedSynapseEnclave {
  url: string;
  objectId: string;
}

interface Props {
  enclaveUrl: string;
  enclaveObjectId: string;
  disabled?: boolean;
  requiresAttestation?: boolean;
  sharedSynapseEnclave?: SharedSynapseEnclave | null;
  synapseManagedEnclaveAvailable?: boolean;
  enclaveDocsUrl?: string;
  onEnclaveUrlChange: (value: string) => void;
  onEnclaveObjectIdChange: (value: string) => void;
  onApplySharedEnclave?: () => void;
  onClearEnclave?: () => void;
  showClearButton?: boolean;
}

/**
 * Nautilus enclave URL + on-chain object id inputs with Synapse shared-enclave
 * preset and self-host documentation link.
 */
export function NautilusEnclaveFields({
  enclaveUrl,
  enclaveObjectId,
  disabled = false,
  requiresAttestation = false,
  sharedSynapseEnclave = null,
  synapseManagedEnclaveAvailable = false,
  enclaveDocsUrl,
  onEnclaveUrlChange,
  onEnclaveObjectIdChange,
  onApplySharedEnclave,
  onClearEnclave,
  showClearButton = false,
}: Props) {
  const usingSharedPreset =
    Boolean(sharedSynapseEnclave) &&
    enclaveUrl.trim() === sharedSynapseEnclave!.url &&
    enclaveObjectId.trim() === sharedSynapseEnclave!.objectId;

  return (
    <div className="grid gap-2">
      <p className="text-[11px] leading-relaxed text-ink-soft">
        {requiresAttestation
          ? 'Required by vault policy — the hosted runtime calls this enclave on every tick and attests the signed decision on-chain.'
          : 'Optional — leave both fields empty to run without Nautilus (local strategy execution).'}
        {' '}
        The <strong className="font-normal text-ink">URL</strong> is where your decision enclave
        listens (<code className="font-mono text-[10px]">POST /decide</code>). The{' '}
        <strong className="font-normal text-ink">object ID</strong> is the on-chain{' '}
        <code className="font-mono text-[10px]">Enclave&lt;DecisionEnclave&gt;</code> created when
        that enclave was registered.
        {enclaveDocsUrl ? (
          <>
            {' '}
            <a
              href={enclaveDocsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[10px] text-accent-orange underline-offset-2 hover:underline"
            >
              Deploy &amp; register your own enclave →
            </a>
          </>
        ) : null}
      </p>

      {synapseManagedEnclaveAvailable && sharedSynapseEnclave && onApplySharedEnclave ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={disabled || usingSharedPreset}
            onClick={onApplySharedEnclave}
            className="btn-flat w-fit"
            data-variant={usingSharedPreset ? 'ghost' : 'accent'}
          >
            {usingSharedPreset ? 'Using Synapse shared enclave' : 'Use Synapse shared testnet enclave'}
          </button>
          {usingSharedPreset ? (
            <span className="font-mono text-[10px] text-state-active">
              Synapse-managed · no self-host needed on testnet
            </span>
          ) : (
            <span className="font-mono text-[10px] text-ink-mute">
              Fills URL + object ID for the registered Synapse testnet enclave
            </span>
          )}
        </div>
      ) : null}

      {!synapseManagedEnclaveAvailable && requiresAttestation ? (
        <p className="rounded-sm border-l-2 border-accent-orange bg-paper p-2 font-mono text-[10px] text-ink-soft">
          No Synapse shared enclave is configured on this network — deploy your own enclave and
          register it on-chain, then paste the URL and object id below.
        </p>
      ) : null}

      {showClearButton && onClearEnclave ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onClearEnclave}
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
          disabled={disabled}
          onChange={(e) => onEnclaveUrlChange(e.target.value)}
          placeholder={sharedSynapseEnclave?.url ?? 'https://…'}
          className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
      <label className="grid gap-1">
        <span className="font-mono text-[10px] text-ink-mute">Enclave object ID</span>
        <input
          type="text"
          value={enclaveObjectId}
          disabled={disabled}
          onChange={(e) => onEnclaveObjectIdChange(e.target.value)}
          placeholder={sharedSynapseEnclave?.objectId ?? '0x…'}
          className="rounded-sm border border-divider bg-paper-strong px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
    </div>
  );
}
