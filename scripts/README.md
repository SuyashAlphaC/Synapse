# `scripts/` — operational tools

Standalone Node CLIs. All TypeScript, all run via `tsx` from the repo
root (so workspace imports resolve correctly):

```bash
npx tsx scripts/<name>.ts [args]
```

Single source of truth for shared constants (active package ID, network,
seeded strategy IDs, DeepBook package) lives in [`_config.ts`](./_config.ts).
Override at the shell:

```bash
PACKAGE_ID=0x… SYNAPSE_NETWORK=mainnet npx tsx scripts/<name>.ts
```

## Scripts

### `_config.ts`

Not executable. Exports `PACKAGE_ID`, `NETWORK`, `SEEDED_STRATEGIES`,
`SEEDED_STRATEGIST_CAPS`, `DEEPBOOK_PACKAGE_ID_TESTNET`. Every other
script imports from here so a package upgrade is a one-line change in
this file.

### `backtest-strategies.ts` — static backtest JSON (offline fallback)

Pulls 90 days of SUI/USD daily closes from CoinGecko, replays bundled
strategies through `evaluate()`, writes JSON to
`web/dashboard/public/backtests/`.

```bash
npx tsx scripts/backtest-strategies.ts
```

**Production:** the dashboard serves **live** backtests via
`GET /api/backtests` and `GET /api/backtests/[strategyId]` — CoinGecko
prices refreshed hourly, every **active** marketplace strategy resolved
from Walrus (or bundled fallback), cached in memory. Static JSON is only
used when the API is unreachable.

### `simulate-tick.ts` — dry-run an agent decision

Loads any vault by ID, fetches market data, builds the same
`StrategyInput` the production runtime would use, calls
`strategy.evaluate()` locally, and prints the decision. **No
transactions, no gas, no signatures** — pure read + compute.

```bash
npx tsx scripts/simulate-tick.ts --vault <0x…>
npx tsx scripts/simulate-tick.ts --vault <0x…> --strategy aggressive-momentum
npx tsx scripts/simulate-tick.ts --vault <0x…> --quote-type <USDC type tag>
```

Use it to debug "why isn't the agent trading?" without burning gas, or
to preview a tick before letting the real runtime fire one.

### `derive-session-addr.ts` — print the Sui address for a `.key` file

Tiny utility that loads a session keypair file (either the JSON form
written by the mint wizard or the bech32 form from the rotate-key
modal) and prints the matching Sui address.

```bash
npx tsx scripts/derive-session-addr.ts ~/Downloads/synapse-session-xxx.key
```

Used to verify a freshly-rotated session matches the on-chain
`session_addr` before starting the runtime.

### `seed-strategies.ts` — one-shot: publish the default 3 strategies

Used once per *new* package deployment to seed the marketplace with the
canonical Conservative / Balanced / Aggressive strategies. Reads the
local Sui CLI keystore (`~/.sui/sui_config/sui.keystore`) to sign.

```bash
npx tsx scripts/seed-strategies.ts
```

Will publish 3 fresh `Strategy` shared objects + 3 `StrategistCap`
objects (owned by the signer). After publish, run `republish-strategies`
to attach real Walrus bundles.

### `republish-strategies.ts` — upload bundles + bump on-chain code_hash

Bundles each strategy's TypeScript source into a sorted-key JSON
manifest, uploads via the public Walrus testnet HTTP publisher, computes
`sha256(canonical_bytes)`, and calls
`strategy_registry::publish_new_version(strategy, cap, hash, blob_id)`
on each of the three seeded strategies.

```bash
WALRUS_EPOCHS=10 npx tsx scripts/republish-strategies.ts
```

Run after any strategy code change you want reflected in the
verifiable-bundle chain. Currently bumps all three seeded strategies to a
fresh version each invocation.

## What's gitignored

- `live-vaults.json` (was used by the previous `seed-live-vaults.ts` +
  `run-live-tick.ts` flow; both removed in favor of the dashboard's mint
  flow + the long-running `@synapse-core/vault` runtime entry point at
  `sdk/packages/vault/src/runtime/bin/run.ts`).
