# LLM Advisor — the AI in the loop

The Walrus track asks for **functional AI agents**. Most Synapse strategies are
deterministic (DCA, rebalancer, momentum). The **LLM Advisor** strategy makes
the agent literally AI-driven, and closes the track's core loop:

```
recall (Walrus/MemWal memory) → reason (Claude) → act (DeepBook) → remember (Walrus/MemWal memory)
```

Each tick, Claude reasons over the live market snapshot **and the vault's
recalled MemWal memory** (past decisions, learned facts, tick counter) to choose
a target base-asset weight. The decision is therefore **causally driven by the
agent's persistent, verifiable memory** — the exact thesis the track asks
builders to demonstrate ("agents become more useful when they can remember").

## Safety: AI reasons, policy bounds

The LLM only outputs a target weight in `[0,1]`, a confidence, and a rationale.
It **cannot** construct an arbitrary trade, exceed the spend cap, or move funds
beyond what the audited conservative-rebalancer + Move VM allow:

- the LLM's weight feeds the **deterministic** rebalancer trade math (slippage
  guards, exact sizing);
- low confidence **widens** the rebalance threshold, so a hesitant model trades
  less;
- `wallet::spend`, expiry, revocation, and the swap allowlist are still enforced
  on-chain — the LLM is advisory, the Move policy is authoritative.

With no `ANTHROPIC_API_KEY`, the strategy degrades to a transparent noop rather
than failing the tick.

## Run it

Set the runtime-configured strategy to the advisor and provide a key:

```bash
export SYNAPSE_STRATEGY=llm-advisor
export ANTHROPIC_API_KEY=sk-ant-...
export SYNAPSE_LLM_MODEL=claude-opus-4-8   # optional; default claude-opus-4-8
# plus the usual SYNAPSE_PACKAGE_ID / SYNAPSE_AGENT_ID / session key
node sdk/packages/vault/dist/runtime/bin/run.js --once
```

The tick will: recall memory → call Claude (adaptive thinking, structured JSON
output) → set the target weight → execute a policy-gated DeepBook swap (or hold)
→ persist the AI rationale to MemWal for the next tick to recall.

## Implementation

- [`sdk/packages/vault/src/strategies/llm-advisor.ts`](../sdk/packages/vault/src/strategies/llm-advisor.ts)
  — `@anthropic-ai/sdk`, `claude-opus-4-8`, adaptive thinking, structured
  outputs (`output_config.format`). The "ask Claude" function is injectable, so
  the decision logic is unit-tested without a network call (8 tests).
- Wired as a selectable runtime strategy via `SYNAPSE_STRATEGY=llm-advisor`.
- Verification: 8 unit tests (no-key noop, error-noop, weight→trade, confidence
  scaling, clamping, memory write). Live run needs a funded vault + API key
  (operator-side, same model as the Seal publish).
