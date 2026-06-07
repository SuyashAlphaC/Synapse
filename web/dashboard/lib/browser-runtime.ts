/**
 * Browser-side wrapper around `@synapse-core/vault`'s VaultRuntime.
 *
 * The same TypeScript runtime that ticks Synapse vaults in a Node
 * server-side process also runs in the browser — every runtime
 * import is now isomorphic. The only difference: we provide our own
 * (a) logger that streams events into React state instead of
 * stdout, and (b) `sessionKeyEnv` with the .key file contents
 * loaded via the File API instead of a filesystem path.
 *
 * This lets a DAO mint a vault, click "Start runtime", and watch
 * ticks fire in real time on the dashboard — no CLI, no Docker, no
 * server. Closing the tab pauses the strategy; opening it resumes.
 * Production deployments use the same TypeScript runtime in a
 * long-lived Docker/Fargate process — code is shared.
 */

// Import from the package root (re-exports the runtime barrel) rather
// than the `/runtime` barrel. The barrel also exports the Node subprocess
// messaging bootstrap, which imports `node:child_process` and cannot enter
// the browser chunk.
import { VaultRuntime, type RuntimeConfig } from '@synapse-core/vault/runtime-core';
import {
  SYNAPSE_PACKAGE_ID,
  SYNAPSE_PACKAGE_HISTORY,
} from './synapse-config';

export interface BrowserRuntimeEvent {
  at: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  /** Arbitrary JSON-serializable detail object (txDigests, balances, etc.). */
  details: Record<string, unknown>;
}

export interface StartBrowserRuntimeArgs {
  agentId: string;
  sessionKeyFileContents: string;
  tickIntervalMs?: number;
  /** Sink for every log line the runtime emits. */
  onEvent: (event: BrowserRuntimeEvent) => void;
}

export interface BrowserRuntimeHandle {
  stop: () => Promise<void>;
  tickOnce: () => Promise<void>;
}

/**
 * Build a logger object that conforms to pino's Logger surface but
 * funnels everything into the React-state sink. Casting to `never`
 * because pino's full Logger interface has ~50 methods we don't use
 * — the runtime touches only `info / warn / error / debug / fatal /
 * trace / child`, which we cover here.
 */
function makeBrowserLogger(
  onEvent: (event: BrowserRuntimeEvent) => void,
  bindings: Record<string, unknown> = {},
): unknown {
  type LogArg = string | Record<string, unknown>;
  const emit = (level: BrowserRuntimeEvent['level']) =>
    (a?: LogArg, b?: string) => {
      const detailsArg = typeof a === 'object' && a !== null ? a : {};
      const msg = typeof a === 'string' ? a : typeof b === 'string' ? b : '';
      onEvent({
        at: Date.now(),
        level,
        msg,
        details: { ...bindings, ...detailsArg },
      });
    };
  const logger = {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: () => {},
    fatal: emit('error'),
    trace: () => {},
    child: (childBindings: Record<string, unknown>) =>
      makeBrowserLogger(onEvent, { ...bindings, ...childBindings }),
  };
  return logger;
}

export async function startBrowserRuntime(
  args: StartBrowserRuntimeArgs,
): Promise<BrowserRuntimeHandle> {
  // Build the same RuntimeConfig the CLI builds, just from the
  // dashboard's already-loaded synapse-config constants instead of
  // env vars. The session key file contents go in via
  // `sessionKeyEnv` — keypair.ts already handles JSON-bundled keys
  // bundling delegate alongside session.
  const config: RuntimeConfig = {
    packageId: SYNAPSE_PACKAGE_ID,
    packageHistory: SYNAPSE_PACKAGE_HISTORY,
    agentId: args.agentId,
    fullnodeUrl: 'https://fullnode.testnet.sui.io:443',
    walrusNetwork: 'testnet',
    sessionKeyEnv: args.sessionKeyFileContents,
    // The runtime will auto-detect the MemWal delegate inside the
    // same JSON; no env config needed.
    //
    // Route MemWal calls through the same-origin proxy. The public
    // relayer doesn't send CORS headers, so a direct browser fetch
    // dies with "TypeError: Failed to fetch" — which aborts the whole
    // tick before it can write on-chain. `/api/memwal-proxy` (a Next
    // route handler) relays to the relayer server-side, with no CORS.
    memwalRelayerUrlOverride: '/api/memwal-proxy',
    tickIntervalMs: args.tickIntervalMs ?? 60_000,
    maxConsecutiveFailures: 5,
    walrusEpochs: 12,
    strategy: undefined as never, // overridden below
  } as RuntimeConfig;
  // RuntimeConfig requires `strategy` (the runtime-side fallback
  // when on-chain strategy ID isn't in KNOWN_STRATEGIES). For the
  // browser path we always defer to the on-chain strategy via the
  // Walrus loader — pass a no-op fallback that just NOOPs.
  config.strategy = {
    id: 'browser-fallback-noop',
    name: 'Browser fallback NOOP',
    version: '1.0.0',
    description: 'Inert fallback used when Walrus loading is unavailable.',
    evaluate: async () => ({
      kind: 'noop',
      rationale: 'Browser runtime: no built-in fallback strategy.',
    }),
  };

  const logger = makeBrowserLogger(args.onEvent);
  // VaultRuntime accepts `deps.logger?` to override the default
  // pino instance. The `as never` is a deliberate escape hatch —
  // our stub satisfies the call sites the runtime actually uses but
  // not the full pino surface.
  const runtime = new VaultRuntime(config, {
    logger: logger as never,
  });
  // Fire-and-forget: start() returns when stop() is called.
  void runtime.start();
  return {
    stop: () => runtime.stop(),
    tickOnce: () => runtime.tickOnce().then(() => undefined),
  };
}
