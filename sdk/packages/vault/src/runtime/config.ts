import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { Strategy } from '../types.js';
import type { SecretsProvider } from './secrets.js';
import { conservativeRebalancer } from '../strategies/conservative-rebalancer.js';
import {
  DEEPBOOK_PACKAGE_ID_TESTNET,
  SUI_TYPE_TAG_TESTNET,
  SUI_USDC_POOL_ID_TESTNET,
  USDC_TYPE_TAG_TESTNET,
} from './deepbook.js';
import {
  parseWalrusAllowlistFromEnv,
  type WalrusStrategyAllowlist,
} from './walrus-loader.js';

export interface RuntimeConfig {
  /**
   * Latest deployed synapse_core package ID. Used for:
   *  - PTB targets (every Move call needs an explicit package address).
   *  - Reading dynamic fields whose Move struct keys were defined in
   *    the latest version (e.g. WalrusConsentKey, added in v3).
   */
  packageId: string;
  /**
   * Every historical synapse_core package ID, newest first. Used to:
   *  - Recognize on-chain objects (AgentIdentity, Strategy) that were
   *    minted under an earlier version — their on-chain type tag is
   *    namespaced by the package that minted them, forever.
   *  - Tolerate the case where a dynamic field type was defined in
   *    one version but the vault was minted under a different one.
   *
   * Read-side scanners walk this list and union results. Always
   * include `packageId` at the head. Wired through
   * `SYNAPSE_PACKAGE_HISTORY` env (comma-separated). When unset,
   * defaults to `[packageId]`.
   */
  packageHistory: readonly string[];
  /** AgentIdentity object ID this runtime operates. */
  agentId: string;
  /** Sui RPC fullnode URL. */
  fullnodeUrl: string;
  /** Walrus network ('testnet' or 'mainnet'). */
  walrusNetwork: 'testnet' | 'mainnet';
  /** Strategy to run. */
  strategy: Strategy;
  /**
   * Path to the session keypair file (base64 32-byte secret or
   * `suiprivkey…` string). Either `sessionKeyPath` or `sessionKeyEnv`
   * must be set; the runtime prefers `sessionKeyEnv` when both exist so
   * containers can inject the secret without bind mounts.
   */
  sessionKeyPath?: string;
  /** In-memory session secret. Wins over `sessionKeyPath` when set. */
  sessionKeyEnv?: string;
  /** MemWal credentials. If absent, runtime runs without memory recall. */
  memwal?: { delegateKeyHex: string; relayerUrl?: string };
  /**
   * Override for the MemWal relayer base URL used when the delegate key
   * is bundled in the session `.key` file (i.e. `memwal` above is unset).
   * The in-browser runtime sets this to a SAME-ORIGIN proxy path
   * (`/api/memwal-proxy`) because the public relayer doesn't send CORS
   * headers — a direct browser `fetch` fails with `TypeError: Failed to
   * fetch`. Server-side (CLI/container) callers leave this unset and get
   * the network-aware default (testnet → staging relayer). The MemWal
   * SDK signs over the request PATH only, never the host, so routing
   * through a verbatim-suffix proxy keeps signatures valid.
   */
  memwalRelayerUrlOverride?: string;
  /**
   * Nautilus attested execution. When BOTH are set, the vault runs in attested
   * mode: the runtime asks the enclave at `enclaveUrl` for a signed decision and
   * gates the rebalance PTB on `decision_attestation::attest_decision` against
   * the `Enclave` object `enclaveObjectId`. Unset → unattested (local strategy).
   */
  enclaveUrl?: string;
  enclaveObjectId?: string;
  /** Pluggable secret source; defaults to env. Backs the per-vault API key. */
  secretsProvider?: SecretsProvider;
  /** Tick interval in milliseconds. Default 600_000 (10 min). */
  tickIntervalMs?: number;
  /** Max consecutive tick failures before exit. Default 5. */
  maxConsecutiveFailures?: number;
  /** Walrus storage epochs for audit reports. Default 5. */
  walrusEpochs?: number;
  /**
   * When set, the runtime Seal-encrypts each audit report before uploading
   * it to Walrus, gated by `synapse_seal::policy::seal_approve`. This MUST
   * be the object ID of a freshly-published (first-version) `synapse_seal`
   * package — Seal rejects upgraded packages as identity namespaces. Wired
   * from `SYNAPSE_SEAL_PACKAGE_ID`. Unset (default) → reports upload as
   * plaintext, so the browser path and existing operators are unaffected.
   */
  sealPackageId?: string;
  /**
   * Override the Seal key-server object IDs (comma-separated, from
   * `SYNAPSE_SEAL_KEY_SERVERS`). Defaults to the Mysten testnet servers
   * baked into `@synapse-core/client`.
   */
  sealKeyServerObjectIds?: readonly string[];
  /**
   * Optional JSON override mapping `Strategy` object IDs to runtime slugs.
   * Wired through `SYNAPSE_STRATEGY_REGISTRY_JSON`. Lets operators teach the
   * runtime about newly-published strategies without recompiling.
   */
  strategyRegistryJson?: string;
  /**
   * Quote token type override (e.g. Circle USDC vs the bundled DBUSDC).
   * Wired through `SYNAPSE_QUOTE_TYPE`. When unset, the runtime auto-detects
   * the first non-SUI token in the vault's holdings.
   */
  quoteTypeTagOverride?: string;
  /**
   * DeepBookV3 pool ID override matching the quote-type override.
   * Wired through `SYNAPSE_POOL_ID`. When unset, the runtime uses the
   * default SUI/DBUSDC pool.
   */
  poolIdOverride?: string;
  /**
   * Trigger auto-refuel when session SUI balance drops below this many
   * MIST. Override via `SYNAPSE_REFUEL_THRESHOLD_MIST`. Default 0.02 SUI.
   */
  refuelThresholdMist?: bigint;
  /**
   * Pull this many MIST from treasury when refueling. Override via
   * `SYNAPSE_REFUEL_AMOUNT_MIST`. Default 0.05 SUI (≈10 ticks of gas).
   */
  refuelAmountMist?: bigint;
  /**
   * Operator-level kill switch for Walrus-loaded strategies. When
   * `false`, the runtime refuses to load any bundle from Walrus
   * regardless of per-vault consent. When `true` (default), the
   * runtime defers to each vault's on-chain consent flag
   * (`AgentIdentity` dynamic field `WalrusConsentKey`). Wired through
   * `SYNAPSE_ALLOW_WALRUS_STRATEGIES`; accepts the literals `0`,
   * `false`, `no`, or `off` (case-insensitive) to disable.
   *
   * Trust model: the per-vault consent is the primary gate, set by
   * the vault owner. This env flag exists so an operator can globally
   * pause Walrus execution (e.g., during incident response) without
   * editing every vault's on-chain state.
   *
   * SECURITY: loaded code runs with full Node privileges in this
   * version. Sandboxing is a follow-up.
   */
  allowWalrusStrategies?: boolean;
  /**
   * Operator-supplied allowlist for Walrus-loaded marketplace strategies.
   * Applied on top of the per-vault on-chain consent gate. When set, the
   * runtime refuses to load any bundle whose `code_hash` (or publisher,
   * once parsed) isn't in the list — defense in depth against a malicious
   * or compromised strategist post-consent. Wired from
   * `SYNAPSE_ALLOWED_STRATEGY_HASHES` / `SYNAPSE_ALLOWED_STRATEGY_PUBLISHERS`.
   */
  walrusAllowlist?: WalrusStrategyAllowlist;
  /**
   * Walrus exchange object IDs for the active network. Used by
   * auto-WAL-refuel to swap SUI → WAL when the session runs low.
   * Wired from `SYNAPSE_WAL_EXCHANGE_IDS` (comma-separated) or
   * hard-coded testnet defaults.
   */
  walExchangeIds?: readonly string[];
  /**
   * Package ID of the `wal_exchange` module (derived at runtime from
   * the exchange object's type). Wired from `SYNAPSE_WAL_EXCHANGE_PKG`;
   * when unset, the runtime inspects the first exchange object on-chain.
   */
  walExchangePkg?: string;
  /**
   * Trigger auto-WAL-refuel when session WAL balance drops below this
   * many FROST (1 WAL = 1_000_000_000 FROST). Override via
   * `SYNAPSE_WAL_REFUEL_THRESHOLD`. Default 0.01 WAL.
   */
  walRefuelThreshold?: bigint;
  /**
   * Max SUI MIST to exchange for WAL per refuel attempt (adaptive — uses
   * less when the session balance is smaller). Override via
   * `SYNAPSE_WAL_REFUEL_AMOUNT`. Default 0.05 SUI.
   */
  walRefuelAmount?: bigint;
  /**
   * Peer vault object IDs to read via shared MemWal namespace each tick.
   * Wired from `SYNAPSE_CROSS_AGENT_PEERS` (comma-separated 0x… ids).
   */
  crossAgentPeerVaultIds?: readonly string[];
  /** Semantic recall query for cross-agent MemWal reads. */
  crossAgentRecallQuery?: string;
  /**
   * When false, skip Sui Stack Messaging consume/emit even if channels are
   * attached. Default true. Set `SYNAPSE_MESSAGING_ENABLED=0` to disable.
   */
  messagingEnabled?: boolean;
  /**
   * Path to `messaging-runtime-bridge/dist/rpc.js`. Defaults to repo-relative
   * path when present; override via `SYNAPSE_MESSAGING_BRIDGE_PATH`.
   */
  messagingBridgeScriptPath?: string;
}

export function loadFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const packageId = required(env.SYNAPSE_PACKAGE_ID, 'SYNAPSE_PACKAGE_ID');
  const packageHistory = parsePackageHistory(env.SYNAPSE_PACKAGE_HISTORY, packageId);
  const agentId = required(env.SYNAPSE_AGENT_ID, 'SYNAPSE_AGENT_ID');
  const sessionKeyPath = env.SYNAPSE_SESSION_KEY_PATH;
  const sessionKeyEnv = env.SYNAPSE_SESSION_KEY ?? env.SYNAPSE_SESSION_SECRET_BASE64;
  if (!sessionKeyPath && !sessionKeyEnv) {
    throw new Error(
      'Set SYNAPSE_SESSION_KEY (inline secret) or SYNAPSE_SESSION_KEY_PATH (file path).',
    );
  }
  const fullnodeUrl = env.SYNAPSE_FULLNODE_URL ?? getJsonRpcFullnodeUrl('testnet');
  const walrusNetwork = parseWalrusNetwork(env.SYNAPSE_WALRUS_NETWORK);

  const delegateKey = env.MEMWAL_DELEGATE_KEY ?? env.SYNAPSE_MEMWAL_DELEGATE_KEY;
  // Default the relayer URL based on the Walrus network: MemWal runs
  // separate endpoints for testnet vs mainnet, and the SDK's built-in
  // default points at production (mainnet). Without this, testnet
  // runtimes silently hit the wrong relayer and get 401s on every
  // recall/remember call.
  //   - testnet → https://relayer.staging.memwal.ai
  //   - mainnet → https://relayer.memwal.ai (SDK default; left undefined)
  // Operator can override via MEMWAL_RELAYER_URL for self-hosted setups.
  const relayerUrl =
    env.MEMWAL_RELAYER_URL ??
    env.SYNAPSE_MEMWAL_RELAYER_URL ??
    (walrusNetwork === 'testnet' ? 'https://relayer.staging.memwal.ai' : undefined);
  const memwal =
    delegateKey !== undefined
      ? {
          delegateKeyHex: required(delegateKey, 'MEMWAL_DELEGATE_KEY'),
          ...(relayerUrl !== undefined ? { relayerUrl } : {}),
        }
      : undefined;

  return {
    packageId,
    packageHistory,
    agentId,
    fullnodeUrl,
    walrusNetwork,
    ...(sessionKeyPath ? { sessionKeyPath } : {}),
    ...(sessionKeyEnv ? { sessionKeyEnv } : {}),
    // Runtime-configured fallback, used only when the vault's on-chain
    // strategy_id resolves to no known slug and no Walrus bundle. Strategies
    // (including llm-advisor) are hired by their on-chain strategy_id and
    // resolved via the slug map — see strategy-resolver.ts — not selected here.
    strategy: conservativeRebalancer({
      baseTypeTag: SUI_TYPE_TAG_TESTNET,
      baseSymbol: 'SUI',
      quoteTypeTag: USDC_TYPE_TAG_TESTNET,
      quoteSymbol: 'DBUSDC',
      targetBaseWeight: numberFromEnv(env.SYNAPSE_TARGET_BASE_WEIGHT, 0.5),
      driftThreshold: numberFromEnv(env.SYNAPSE_DRIFT_THRESHOLD, 0.05),
      poolId: env.SYNAPSE_DEEPBOOK_POOL_ID ?? SUI_USDC_POOL_ID_TESTNET,
      slippageTolerance: numberFromEnv(env.SYNAPSE_SLIPPAGE_TOLERANCE, 0.005),
    }),
    ...(memwal ? { memwal } : {}),
    ...(env.SYNAPSE_TICK_INTERVAL_MS
      ? { tickIntervalMs: Number(env.SYNAPSE_TICK_INTERVAL_MS) }
      : {}),
    ...(env.SYNAPSE_MAX_FAILURES ? { maxConsecutiveFailures: Number(env.SYNAPSE_MAX_FAILURES) } : {}),
    ...(env.SYNAPSE_WALRUS_EPOCHS ? { walrusEpochs: Number(env.SYNAPSE_WALRUS_EPOCHS) } : {}),
    ...(env.SYNAPSE_SEAL_PACKAGE_ID ? { sealPackageId: env.SYNAPSE_SEAL_PACKAGE_ID } : {}),
    ...(env.SYNAPSE_SEAL_KEY_SERVERS
      ? {
          sealKeyServerObjectIds: env.SYNAPSE_SEAL_KEY_SERVERS.split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : {}),
    ...(env.SYNAPSE_STRATEGY_REGISTRY_JSON
      ? { strategyRegistryJson: env.SYNAPSE_STRATEGY_REGISTRY_JSON }
      : {}),
    ...(env.SYNAPSE_QUOTE_TYPE ? { quoteTypeTagOverride: env.SYNAPSE_QUOTE_TYPE } : {}),
    ...(env.SYNAPSE_POOL_ID ? { poolIdOverride: env.SYNAPSE_POOL_ID } : {}),
    ...(env.SYNAPSE_ENCLAVE_URL ? { enclaveUrl: env.SYNAPSE_ENCLAVE_URL } : {}),
    ...(env.SYNAPSE_ENCLAVE_OBJECT_ID ? { enclaveObjectId: env.SYNAPSE_ENCLAVE_OBJECT_ID } : {}),
    ...(env.SYNAPSE_REFUEL_THRESHOLD_MIST
      ? { refuelThresholdMist: BigInt(env.SYNAPSE_REFUEL_THRESHOLD_MIST) }
      : {}),
    ...(env.SYNAPSE_REFUEL_AMOUNT_MIST
      ? { refuelAmountMist: BigInt(env.SYNAPSE_REFUEL_AMOUNT_MIST) }
      : {}),
    // Kill-switch semantics: default true (operator allows, per-vault
    // consent gates). Set the env to a falsy literal to globally disable.
    ...(parseDisableEnv(env.SYNAPSE_ALLOW_WALRUS_STRATEGIES)
      ? { allowWalrusStrategies: false }
      : {}),
    ...(parseWalrusAllowlistFromEnv(env)
      ? { walrusAllowlist: parseWalrusAllowlistFromEnv(env) as WalrusStrategyAllowlist }
      : {}),
    ...parseWalExchangeEnv(env, walrusNetwork),
    ...(parsePeerVaultIds(env.SYNAPSE_CROSS_AGENT_PEERS)
      ? { crossAgentPeerVaultIds: parsePeerVaultIds(env.SYNAPSE_CROSS_AGENT_PEERS)! }
      : {}),
    ...(env.SYNAPSE_CROSS_AGENT_QUERY
      ? { crossAgentRecallQuery: env.SYNAPSE_CROSS_AGENT_QUERY }
      : {}),
    ...(parseDisableEnv(env.SYNAPSE_MESSAGING_ENABLED) ? { messagingEnabled: false } : {}),
    ...(env.SYNAPSE_MESSAGING_BRIDGE_PATH
      ? { messagingBridgeScriptPath: env.SYNAPSE_MESSAGING_BRIDGE_PATH }
      : {}),
  };
}

export function deepbookPackageForRuntime(config: RuntimeConfig): string {
  // DeepBook integration is testnet-pinned: the package ID is hardcoded and the
  // swap path supplies a zero DEEP fee coin (only valid for whitelisted testnet
  // pools). Fail fast rather than building a mainnet tx against a testnet
  // package — which would abort opaquely on-chain.
  if (config.walrusNetwork === 'mainnet') {
    throw new Error(
      'Mainnet DeepBook trading is not yet wired (testnet-pinned package + zero-DEEP fee model). Set SYNAPSE_WALRUS_NETWORK=testnet.',
    );
  }
  return DEEPBOOK_PACKAGE_ID_TESTNET;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWalrusNetwork(value: string | undefined): 'testnet' | 'mainnet' {
  if (value === undefined || value === 'testnet') return 'testnet';
  if (value === 'mainnet') return 'mainnet';
  throw new Error(`SYNAPSE_WALRUS_NETWORK must be "testnet" or "mainnet"; got ${value}`);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env value: ${value}`);
  return parsed;
}

/**
 * Parse `SYNAPSE_PACKAGE_HISTORY` as a comma-separated list of 0x-prefixed
 * package IDs, newest first. Always returns a non-empty array that
 * starts with `packageId` (deduped + with the latest forced to the
 * head so downstream code can safely use `history[0]`).
 */
function parsePackageHistory(
  raw: string | undefined,
  packageId: string,
): readonly string[] {
  const fromEnv = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of fromEnv) {
    if (!/^0x[0-9a-fA-F]+$/.test(entry)) {
      throw new Error(
        `SYNAPSE_PACKAGE_HISTORY: "${entry}" is not a 0x-prefixed hex package ID`,
      );
    }
  }
  const seen = new Set<string>([packageId]);
  const ordered: string[] = [packageId];
  for (const entry of fromEnv) {
    if (!seen.has(entry)) {
      seen.add(entry);
      ordered.push(entry);
    }
  }
  return ordered;
}

/**
 * True when the env var is set to an explicit disable literal. Anything
 * else (unset, empty, or affirmative) means "not disabled" — the
 * kill-switch is OFF by default; only explicit `false`/`0`/`no`/`off`
 * trips it.
 */
function parseDisableEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lowered = value.trim().toLowerCase();
  return lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off';
}

function parsePeerVaultIds(raw: string | undefined): readonly string[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  for (const id of ids) {
    if (!/^0x[0-9a-fA-F]+$/.test(id)) {
      throw new Error(`SYNAPSE_CROSS_AGENT_PEERS: "${id}" is not a 0x-prefixed object id`);
    }
  }
  return ids;
}

const TESTNET_WAL_EXCHANGE_IDS = [
  '0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073',
  '0x19825121c52080bb1073662231cfea5c0e4d905fd13e95f21e9a018f2ef41862',
  '0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5',
  '0x8d63209cf8589ce7aef8f262437163c67577ed09f3e636a9d8e0813843fb8bf1',
] as const;

function parseWalExchangeEnv(
  env: NodeJS.ProcessEnv,
  network: 'testnet' | 'mainnet',
): Partial<RuntimeConfig> {
  const ids = env.SYNAPSE_WAL_EXCHANGE_IDS
    ? env.SYNAPSE_WAL_EXCHANGE_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : network === 'testnet'
      ? [...TESTNET_WAL_EXCHANGE_IDS]
      : undefined;
  return {
    ...(ids ? { walExchangeIds: ids } : {}),
    ...(env.SYNAPSE_WAL_EXCHANGE_PKG ? { walExchangePkg: env.SYNAPSE_WAL_EXCHANGE_PKG } : {}),
    ...(env.SYNAPSE_WAL_REFUEL_THRESHOLD
      ? { walRefuelThreshold: BigInt(env.SYNAPSE_WAL_REFUEL_THRESHOLD) }
      : {}),
    ...(env.SYNAPSE_WAL_REFUEL_AMOUNT
      ? { walRefuelAmount: BigInt(env.SYNAPSE_WAL_REFUEL_AMOUNT) }
      : {}),
  };
}
