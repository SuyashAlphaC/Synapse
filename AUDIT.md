# Synapse Vault — Final Audit Report

Caveman-style prose (compressed). Code symbols/paths/numbers verbatim. Findings ONLY from provided verified data; nothing invented. "uncertain" flagged where verdict so.

---

## 1. Executive Summary

Synapse = autonomous on-chain treasury agent. Core Move gating model sound (assert_can_act + assert_package_allowed + per-epoch spend cap, Move arithmetic aborts on overflow). BUT economic trust boundary leaks: session key over-privileged on value movement + reputation. Off-chain stack has 1 fully-broken subsystem (indexer) + several real runtime correctness bugs corrupting reputation/royalty + an unbuildable client pkg version mismatch.

**Severity counts (verified findings):**
- critical: 1
- high: 7
- medium: 14
- low: 22
- uncertain: 1 (low-tier, LLM rationale persist)

**Fix first (top 5):**

1. **pay_strategist_royalty treasury drain** (high, 2 auditors confirm same defect, agent.move:438-475) — session key drains full treasury to strategist, bypasses per-epoch spend cap. Breaks core invariant "compromised session key still safe". Charge royalty vs per-epoch budget OR derive profit on-chain.
2. **Indexer snake_case/camelCase mismatch** (critical, indexer.ts normalize L147-165) — every vault view empty. Whole indexer non-functional. Fix field decode.
3. **session-key.ts generateSessionKey corrupts Ed25519 secret** + **client pkg imports nonexistent @mysten/sui v2.16.2** (high) — session key unusable + client pkg cannot build/import. Headline SDK broken.
4. **Alpha snapshot saved PRE-trade + MemWal-remember failure trips kill-switch** (high pair, runtime.ts) — corrupts on-chain reputation + inflates royalty; flaky relayer halts a fully-successful runtime.
5. **CI runs no Move tests + never builds dashboard** (high) — all money/access-control + ship UI ships uncaught on green CI.

Overall health: **C+**. On-chain core mostly solid (Move VM bounds blast radius on most bugs -> few fund-loss paths), but economic-input trust gaps + off-chain read/build breakage drag it down. Most defects = correctness/reputation/availability not direct theft, EXCEPT royalty drain.

---

## 2. Critical & High Findings

### 2.1 Economic trust-boundary: session key over-privileged (HIGH x2 — same root defect)

**pay_strategist_royalty drains treasury, no cap + no owner gate**
- Where: `move/synapse_core/sources/agent.move` `pay_strategist_royalty<T>` lines 438-475. Confirmed by BOTH move-core + move-seal-econ auditors.
- What: fn gated ONLY by assert_can_act (line 444 -> !revoked + sender==session_addr + epoch<expiry). profit_amount = caller-supplied u64, unbounded (line 441). payout = profit_amount * royalty_bps / 10_000 (453-454), bounded ONLY by treasury balance (463 assert bal.value() >= royalty). NO record_spend, NO reset_epoch_if_new, NO per-epoch royalty cap, NO owner gate. Comment 435-437 ADMITS royalties skip per-epoch cap by design.
- Why matters: compromised session calls profit_amount = treasury_balance * 10000 / royalty_bps -> royalty == full treasury -> drains 100% one txn, repeatable per epoch (no accumulator). royalty_bps <= MAX_ROYALTY_BPS=5000 (50%, strategy_registry.move:29/141). Defeats stated invariant "session key fully compromised, protocol still rejects out-of-policy actions". Contrast wallet::spend (wallet.move:57-91) = 4-layer gate; pay_strategist_royalty bypasses all.
- Nuance (verifier): payout dest = strategist addr fixed at adopt (line 467 strategist(strategy)), frozen via EStrategyMismatch -> pure session compromise CANNOT redirect to attacker addr. Real exfil paths: (1) strategist collusion w/ compromised session, (2) attacker self-publishes strategy (publish() permissionless, strategist=ctx.sender(), strategy_registry.move:143) + vault adopts it -> attacker IS strategist. Even non-collude: compromised session permanently drains treasury to legit strategist (irreversible vault loss). Move VM bounds blast radius to strategist addr, does NOT prevent loss.
- Fix: BEST — derive profit on-chain from treasury NAV delta vs checkpointed high-water-mark, kill caller-supplied profit_amount. OR charge royalty vs per-epoch budget (call reset_epoch_if_new + record_spend inside fn). MIN — owner-set per-epoch royalty cap mirroring OperationalBudget + assert strategy.active + sanity-bound profit_amount vs treasury value. Owner co-sign for large royalties best.

### 2.2 Indexer reads camelCase, Sui parsedJson is snake_case -> ALL vault views empty (CRITICAL)

- Where: `sdk/packages/indexer/src/indexer.ts` normalize() L147-165, holdings() L187-216, rebalances() L219-245, projectTimelineEntry() L252-349.
- What: normalize() casts e.parsedJson straight `as unknown as IndexedEvent` (L164), NO field rename. Move emits snake_case (agent_id, token_type, amount, input_amount, output_amount, base_type, quote_type, walrus_blob_id, artifact_slot — verified wallet.move/deepbook_adapter.move/agent.move/artifacts.move). Indexer reads camelCase (e.payload.agentId, tokenType, inputAmount). Rest of repo correctly reads snake_case (publisher.ts L201-203 artifact_slot, runtime.ts L1053 output_amount, runtime.test.ts L207). Indexer alone broke convention.
- Why matters: every filter `e.payload.agentId === vaultId` -> `undefined === vaultId` -> false on EVERY event. holdings() -> empty + artifactCount 0; vaultTimeline() -> []; rebalances() -> []. Dashboard + Memory Inspector show nothing. Core indexer feature non-functional. Off-chain read bug, no Move mitigation.
- Fix: per-event-kind decoder in normalize(): map snake_case->camelCase + coerce types (BigInt u64; Uint8Array vector<u8>; TypeName fields arrive as `{ name: "addr::mod::Struct" }` object NOT string -> extract `.name`). Drop blanket cast. Add unit test w/ real snake_case parsedJson fixture.

### 2.3 SDK client unbuildable + session key corrupted (HIGH x2)

**generateSessionKey corrupts Ed25519 secret**
- Where: `sdk/packages/client/src/session-key.ts` L42-46.
- What: keypair.getSecretKey() returns Bech32 `suiprivkey1<base32+checksum>`. code strips literal 'suiprivkey' then runs fromBase64 on Bech32 body (begins '1', NOT base64). decoded bytes wrong content + wrong len (~44-48 != 32). restoreSessionKey -> throws 'expected 32-byte secret' OR wrong keypair/addr. Sibling vault keypair.ts:64-65 proves correct path (fromSecretKey on full suiprivkey string). generateSessionKey publicly exported (index.ts:19). No round-trip test.
- Why matters: persisted session secret unusable -> agent runtime restore throws OR signs wrong key -> txns rejected (sender != session_addr per assert_can_act). Any consumer loses key material.
- Fix: `import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'; const { secretKey } = decodeSuiPrivateKey(keypair.getSecretKey()); secretBase64 = toBase64(secretKey)`. Add round-trip test.

**client pkg imports nonexistent @mysten/sui v2.16.2** (from sdk-client subsystem summary — high)
- What: entire client pkg imports @mysten/sui v2.16.2 surface (@mysten/sui/jsonRpc, SuiJsonRpcClient, getJsonRpcFullnodeUrl). Real SDK = v1.x (@mysten/sui/client/SuiClient/getFullnodeUrl). No node_modules installed; lockfile has fabricated 2.16.2. pkg cannot build/import at runtime.
- Why matters: client pkg dead on arrival -> blocks SDK consumers + indexer (which uses SuiJsonRpcClient).
- Fix: migrate to @mysten/sui v1.x client surface; regenerate lockfile against real published version.

### 2.4 Runtime alpha/reputation/royalty corruption (HIGH x2)

**Alpha snapshot saved PRE-trade -> rebalance miscounted as alpha**
- Where: `sdk/packages/vault/src/runtime/runtime.ts` #tickOnceInner line 608 + #savePreviousTick 994-1005 + #computeAlpha 938-958.
- What: savePreviousTick stores `holdings` loaded at tick START (pre-trade, line 412). Rebalance PTB (584-589) swaps on-chain, NO post-trade re-read. Next tick navNow = post-trade holdings, navIfHeld = pre-trade snapshot -> alphaUsd includes trade delta NOT just price drift. Violates doc 914-918 (nav_hold uses END-of-tick holdings). Noop path correct (pre==post).
- Why matters: every tick following rebalance -> distorted alpha -> corrupts on-chain record_tick_performance reputation counters AND inflates royaltyMist (computeRoyaltyMist same alphaUsd basis). Verifier downgrade high->medium: both legs priced at SAME current-tick prices -> distortion ~= swap fee/slippage + intra-snapshot drift, NOT full conversion value. Systematic mis-attribution persisting on-chain.
- Fix: derive post-trade holdings from parseExecutedTrades (line 590, has real output_amount) before line 608 savePreviousTick (subtract amountIn from fromTypeTag, add amountOut to toTypeTag). Avoids extra RPC. Watch dust remainder.

**MemWal remember failure trips kill-switch + drops alpha snapshot**
- Where: runtime.ts rebalance path 589-608; noop 497-517; rememberStrategyOutcome memory.ts 207-212.
- What: after waitForTransaction succeeds (trade final on-chain), code calls `await rememberStrategyOutcome(...)` (601) then savePreviousTick (608), NO try/catch. rememberAndWait timeoutMs 120_000 can throw on flaky relayer. Throw escapes -> tickOnce treats as REAL failure (#consecutiveFailures += 1, line 208), NOT TickSkippedError (those only wrap pre-PTB stages). savePreviousTick never runs.
- Why matters: flaky MemWal relayer alone trips maxConsecutiveFailures (default 5) -> process.exitCode=1 + stop, despite every on-chain trade succeeding. previousTick not saved -> next-tick alpha vs stale snapshot. Valid receipt discarded. No fund loss (Move VM atomic) but runtime self-halt + alpha corruption.
- Fix: wrap rememberStrategyOutcome in try/catch, log warn, never rethrow. Move savePreviousTick BEFORE remember (or finally). Apply BOTH paths. recall (452-458) shares defect class -> wrap as TickSkippedError lower priority.

### 2.5 Soft-delete tombstone broken -> deleted memory resurfaces (HIGH)

- Where: `sdk/packages/adapters/langgraph/src/index.ts` handlePut L181-198, handleGet L236-257, handleSearch L274-288.
- What: delete writes NEW tombstone memory + keyIndex.delete, does NOT evict original MemWal blob (MemWal SDK 0.0.3 no forget API). recall ranks by SIMILARITY not recency. handleGet returns FIRST decoded match w/ matching key (L247 returns null ONLY if first match is tombstone) -> original ranks first -> returns stale deleted value + re-caches it (L248). handleSearch skips tombstone (L277 continue) but keeps original. NOT only cross-instance: same-instance get-after-delete cache-miss falls to same buggy recall.
- Why matters: deletes unreliable across sessions/agents (headline cross-session feature). Revoked/forgotten memory reappears -> stale/sensitive data served after delete. NOT bounded by on-chain revocation (per-item soft-delete, not AgentIdentity revoke).
- Fix: resolve by max writtenAt per (namespace,key): scan ENTIRE recalled.results for ALL key matches, pick newest; newest tombstone -> null. Same dedup in handleSearch. CAVEAT: recall top-K (defaultLimit 5) may MISS tombstone entirely -> deeper bug, real fix needs key-indexed lookup or forget API.

### 2.6 CI gap: no Move tests, no dashboard build (HIGH)

- Where: `.github/workflows/ci.yml` sole job vault-runtime L16-63.
- What: CI typechecks/tests vault TS + forbidden-pattern + gitignore scan + docker build. Move contracts (8 modules: agent, wallet, strategy_registry, deepbook_adapter, attestation, coordination, messaging_bridge, artifacts) NEVER `sui move build|test`. root package.json HAS move:test + move:build scripts, CI omits both. Only 1 Move test file (agent_test.move). web/dashboard (not a workspace member) never next build/typecheck'd.
- Why matters: all money + access-control lives in Move (wallet::spend, royalty, rotate_session_key, assert_can_act). Regression ships green CI. Broken dashboard build (demo surface judges see) ships undetected. NOT Move-VM-mitigated — bug IS in the gate code.
- Fix: CI job setup-sui + `cd move/synapse_core && sui move test` (+ synapse_seal). 2nd job: web/dashboard npm ci + next build + add tsc --noEmit typecheck (none exists). Gate merge on both.

---

## 3. Medium & Low Findings (by subsystem)

### move-core
- **record_tick unbounded alpha, no rate limit** (medium, strategy_registry.move:298-319 via agent.move:409-428). Caller-supplied alpha_bps_pos/neg -> cumulative counters, only gate assert_can_act. Self-dealing strategist self-mints vault, spams +alpha -> climbs leaderboard. EStrategyMismatch blocks cross-strategy grief (own strategy only). Fix: bound alpha per tick (MAX_TICK_BPS), per-epoch tick limit, OR derive from NAV delta.
- **set_operational_cap / set_walrus_consent miss !revoked guard** (low, agent.move 484-509, 571-596). All peer mutators guard; these 2 + remove_approved_package don't. Revoked vault mutates state + emits gov events. No fund loss (downstream gated). Fix: add `assert!(!identity.revoked, ERevoked)`.
- **operational_spent_this_epoch accessor stale pre-epoch-roll** (low, agent.move 635-643). No ctx, no epoch compare; inconsistent w/ operational_remaining (645-657). Display-only, on-chain funds correct. Fix: add ctx param, return 0 when epoch_now > last_epoch_seen.
- **Negative-path tests miss epoch-rollover/expiry/royalty-balance** (low, agent_test.move). Zero ts::next_epoch anywhere; no EExpired test; no EInsufficientBalance royalty test. reset_epoch_if_new + expiry gate untested. NOTE verifier: claim #3 "royalty cap-bypass" framing dropped — pay_strategist_royalty intentionally independent of spend_per_epoch, not a test-gap bypass. Fix: add epoch-advance tests + EExpired + royalty EInsufficientBalance cases.

### move-seal-econ
- **record_tick_performance alpha caller-controlled** (medium) — same self-inflation as record_tick above. Verifier correction: rival-grief leg FALSE (EStrategyMismatch blocks). Marketplace also exposes objective non-gameable sorts (aum-real-capital, vaults, recent). Fix: assert XOR pos/neg + MAX_ALPHA_BPS=5000 + ideally derive from NAV.
- **total_aum_committed permanently 0** (medium, missing-feature, agent.move:207 sole caller passes literal 0). Documented reputation metric dead. Marketplace DEFAULT sort='aum' (marketplace-browser.tsx:34) -> all strategies tie at 0 -> no-op ranking. Fix: thread real AUM into new()+record_vault_minted, OR drop field+event arg+off-chain consumers + change default sort.
- **Royalty integer division truncates toward zero** (low, agent.move 453-455). profit_amount*royalty_bps < 10000 -> royalty==0 -> no payout. No fund loss (stays in vault), u128 intermediate safe. Acceptable; doc floor behavior.
- **seal_approve prefix lacks 32-byte boundary pin** (low, policy.move 23-37). Confidentiality SOUND (fail-closed on short ids, non-owner can't forge victim-prefix). Residual = one session addr decrypts EVERY id sharing 32-byte prefix -> no per-artifact revocation, suffix non-authenticating. Fix: explicit len>=32 assert (defense-in-depth) + 2nd seal_approve variant for granular revocation; document suffix non-authenticating.

### sdk-client
- **defaultNetworkConfig hardcodes synapseCorePackageId '0x0' all networks** (low, config.ts 22/32/40/49). target() no validation -> unoverridden builds 0x0::... calls. Move VM rejects at submit (clean fail). Fix: assertValidPackageId in target() rejecting '0x0'; ship real ids.
- **newAgent/buildMintPTB no input validation** (low, agent.ts 25-43). No expiry>0/spend>0/address checks (vs strategy.ts which validates). Move VM gates -> wasted gas + round-trip only. Fix: mirror strategy.ts guards.
- **buildSynapseSealClient defaults verifyKeyServers=false** (low, seal.ts:50). Skips KeyServer authenticity check; both callers (publisher.ts:160, seal-decrypt.ts:44) inherit. Testnet-ok, mainnet weakens TSS trust. Doesn't gate decrypt auth (Move seal_approve does). Fix: default true OR derive from network.
- **sealIdForAddress no 32-byte normalize/validate** (low, seal.ts 61-83). Un-normalized addr -> un-decryptable id (fails CLOSED). Live caller passes toSuiAddress() (safe); exported helper latent footgun. Fix: normalizeSuiAddress + assert 32 bytes.
- **recordTickPerformance no u64 range guard** (low, agent.ts 121-140). bigint -> tx.pure.u64, BCS throws on negative/overflow at build (opaque). Pure DX. Fix: assert 0 <= val < 2^64 + doc one-leg-nonzero.

### vault-runtime
- **authorize_swap/record_swap type-arg order wrong for direction=1** (medium, executor.ts 98-108, 129-141). Both pass [fromTypeTag, toTypeTag]=<Base,Quote>; for dir=1 (quote->base) from=quote,to=base -> emits SWAPPED base_type/quote_type. Many strategies emit dir=1 (mean-reversion, pair-arbitrage, pyth-ema-crossover, conservative-rebalancer). Trade executes fine (deepbook.ts:80 correct), only audit events misattributed. Fix: `typeArguments = direction===1 ? [toTypeTag, fromTypeTag] : [fromTypeTag, toTypeTag]` both call sites; use SwapDirection enum.
- **record_swap logs minAmountOut as output_amount + aborts on min=0** (medium, executor.ts:138). output_amount arg = trade.minAmountOut (floor), never real fill. parseExecutedTrades reads it back -> receipt.amountOut == floor -> executionPrice/PnL understated. Move asserts output_amount>0 (EZeroOutput) -> min=0 trade aborts whole PTB. Treasury accounting correct (deposit takes real coin). Fix: Move measure coin::value before deposit -> truthful event + clamp for zero-abort.
- **Pyth prices unchecked, no staleness/confidence gate** (medium, oracle.ts 88-101, 63-70). getPriceUnchecked + getPriceAsNumberUnchecked, no publish_time/conf. Stale price -> wrong NAV/alpha/royalty/minAmountOut sizing. mergePrices treats oracle priority-1 (never falls to DeepBook mid on stale). Fix: read publishTime, drop feed if now-publishTime > 60s -> fall to DeepBook mid; optionally conf threshold.
- **Walrus-loaded strategy runs full Node privileges, no sandbox** (medium, walrus-loader.ts 238-286). Hash-verified bundle dynamically imported + evaluated in-process; hash proves bytes not safety. Loaded module reads process.env (SYNAPSE_SESSION_KEY/MEMWAL_DELEGATE_KEY) -> exfil -> drain. publisher allowlist parsed but NEVER enforced on exec path (line 69 advisory; assertHashAllowed checks only hashes). Two gates required: on-chain owner consent (acceptsWalrusExecution) + operator env. Scoped to consenting vaults. Fix: impl node:vm SourceTextModule sandbox + enforce publisher allowlist on exec path + keep session key out of process.env reachable by module.
- **signAndExecuteWithRetry wraps full submit -> post-submit blip re-submits** (low, runtime.ts 32-57). Retries whole signAndExecuteTransaction; 'socket hang up'/'fetch failed' after submit indistinguishable. Sui digest idempotency neuters double-exec (byte-identical signed txn -> same digest -> cached effects). Residual = lock/equivocation err not in TRANSIENT patterns -> rethrown -> false #consecutiveFailures++ on landed tx -> possible false kill-switch. Fix: split build from submit; probe getTransactionBlock(digest) before re-submit.
- **parseArtifactSlot throws post-commit -> receipt lost** (low, publisher.ts 198-207; callers runtime.ts 597+887). Throws if no ArtifactPublishedEvent, AFTER waitForTransaction. Throw (not TickSkippedError) -> committed tick counted as failure, alpha snapshot + memory lost. Low-prob trigger (event-shape divergence). Fix: return 0n on miss + warn, never throw post-commit.
- **tick_failed alert + no-tick watchdog documented but unimplemented** (low, run.ts 101-107, alerts.ts 22-26). AlertEvent declares 'tick_failed' but sendAlert never emits it (only runtime_started/failed/max_failures). heartbeat only logs locally + .unref(). Sustained outage classified as skips -> resets counter -> vault silently noops forever, no alert. Fix: remove unused enum OR impl tick_failed emit + external no-tick watchdog (watchdog mandatory — skip-reset path never hits failure branch).
- **zero-DEEP swap only valid testnet** (low, deepbook.ts 52-92). coin::zero<DEEP> + hardcoded DEEPBOOK_PACKAGE_ID_TESTNET (runtime.ts:551). walrusNetwork:'mainnet' is supported config but mainnet rebalance aborts. Fix: per-network DeepBook pkg + DEEP coin resolver; fail-fast at config load when mainnet.
- **Royalty/record_tick on noop aborts whole tick if treasury lacks SUI Balance** (low, runtime.ts 864-874+573-583). royaltyMist>0 -> pay_strategist_royalty<SUI>; Move asserts Balance<SUI> exists (EInsufficientBalance) -> USDC-only vault w/ alpha reverts entire tick (lose record_tick + audit). Self-recovering. Fix: pre-check SUI holdings >= basis*royalty_bps/10_000 before adding moveCall.
- **redactBindings depth cap (>6) leaks deeply-nested secrets** (low, logger.ts:81). Returns input unredacted at depth>6 BEFORE string scan. Secret at depth>=7 bypasses redaction. Call sites log shallow today. Fix: run redactString on string leaves at cutoff; gate only recursion. NOTE err.cause not walked (separate gap).

### strategies-ai
- **Recalled MemWal facts injected verbatim -> prompt injection** (medium, llm-advisor.ts L230-249 + memory.ts L85,L110). freeformFacts pushed verbatim (no sanitize) -> buildPrompt drops last 8 facts as `- ${f}`, no fence/escape/length cap, no "data not instructions" system line. Injected directive flips targetBaseWeight. Codebase DESIGNS freeform facts as external-injection channel (freeze:risk-off). Bounded by clamp01 [0,1] + Move spend cap -> churn-within-cap (slippage bleed/whipsaw), no fund drain. Self-reinforcing (rationale persisted->recalled). Fix: fence facts in untrusted-DATA block; cap length; feed LLM only own-vault structured outcome facts, route freeform to deterministic strategies; keep clamp01.
- **usdToAtomic BigInt(NaN) throw uncaught on llm-advisor path** (low, conservative-rebalancer.ts L282-287). priceUsd<=0 guard misses NaN/Inf usd -> BigInt(NaN) throws. llm-advisor L135 rebal.evaluate NOT try-wrapped -> crashes tick (no noop). Same pattern balanced-yield/aggressive-momentum/pair-arbitrage. Throw aborts BEFORE PTB -> funds safe, availability/audit only. Narrow reach (needs malformed feed). Fix: `if (!Number.isFinite(usd)||!Number.isFinite(priceUsd)||priceUsd<=0) return 0n` all 4; wrap rebal.evaluate.
- **bytesToAsciiHex heuristic can mis-decode accountId; namespace fatal:false corrupts** (low, memwal-bridge index.ts L181-199). Heuristic hex-regex branch + fatal:false TextDecoder. Verifier: accountId collision near-unreachable (~10^-34); claimed cross-tenant leak UNSUBSTANTIATED (failures -> empty recall, not collision). Real residual = namespace U+FFFD on malformed bytes. Fix: explicit per-contract encode; fatal:true; validate accountId regex. Drop cross-tenant claim.
- **@anthropic-ai/sdk hard dep of vault pkg, no serverExternalPackages** (low, vault/package.json:48). Runtime browser exclusion SOUND today (noop-before-import + turbopackIgnore + LLM_ADVISOR_ID absent from KNOWN_STRATEGIES). Latent: future static bundler pulls Node-only submodules. Fix: move to optionalDependencies + next.config serverExternalPackages + build-time assert.
- **LLM rationale persisted no length cap** (low, UNCERTAIN, llm-advisor.ts L158-168+L208-220). Verifier verdict=uncertain: finding's prompt-recall/injection claim WRONG — held-branch fact already 160-capped, rebalance fact uses deterministic decision.summary (no model text). Real residual = unbounded model text in Walrus blobs via NON-prompt paths (rationaleMarkdown L147 report-only; outcome rationale memory.ts L199-200 -> recentDecisions, not prompt). Benign blob/token hygiene, no injection compounding. Fix (if clamping): clamp rec.rationale ~280 at parse defaultAdvise L216-220 (single chokepoint). Drop injection framing.

### indexer-adapters
- **Numeric event fields arrive as strings -> bigint+string TypeError** (medium, indexer.ts holdings L197-204). normalize never BigInt()-converts. `0n + '999'` -> string concat (silent corrupt) or `0n - '999'` throws. Masked today by field-name bug. Fix: BigInt() every u64 field in normalize.
- **vector<u8> treated as Uint8Array but parsedJson gives number[]** (medium, indexer.ts utf8() L376-378). TextDecoder.decode(number[]) throws / decode(undefined)="" today (field-name bug). walrus blob ids/namespaces garbled. Fix: coerce number[]->Uint8Array.from / base64-decode + fix field names (Uint8Array.from(undefined) throws if only utf8 fixed).
- **Event cursor in-memory only -> genesis re-scan every restart** (medium, indexer.ts cursors L57). Never persisted; restart -> null cursor -> full re-scan, slow catchup + RPC burn. Recoverable (re-reads same events). Fix: persist per-module cursor (file/sqlite); flush in stop().
- **Unbounded events[] growth + O(n) per-query scans** (low, indexer.ts L59). Append-only, never pruned -> OOM; holdings/timeline/rebalances full-scan per request. Demo-scoped v1. Fix: ring-buffer cap + per-vault incremental indexes.
- **GraphQL endpoint no auth/rate-limit/depth-cost on 0.0.0.0** (medium, server.ts 28-43, serve.ts:44 HOST default '0.0.0.0'). No guards; uncapped events(limit) + O(n) resolvers -> cheap DoS. Data already public on-chain (confidentiality not primary). Fix: cap limit, graphql-armor/maxDepth, default bind 127.0.0.1, rate-limit.
- **search offset double-applied** (medium, langgraph index.ts 260-290). recall pre-truncates to limit (no offset param), then matches.slice(offset, offset+limit) -> offset>0 drops never-fetched results, offset>=limit always empty; pre-slice filter shrinks below limit. Fix: over-fetch recall limit=offset+limit, filter, then slice. True deep pagination needs relayer offset support.
- **listNamespaces ignores maxDepth + matchConditions** (low, langgraph index.ts 292-313). Only offset/limit applied; discriminator requires 'limit' in op -> op w/o limit -> null. Public wrapper always defaults limit (mitigated). Fix: apply maxDepth+matchConditions; reclassify by absence of key/namespace/namespacePrefix.
- **similarityFromDistance can exceed [-1,1]** (low, langgraph index.ts 329-331). `1 - distance`, no clamp; distance>1 -> negative. Verifier: 1-distance IS correct cosine-sim recovery; doc already states [-1,1]; only example.ts console.log consumes. Proposed `/2` rescale WRONG. Fix (if defensive): Math.max(-1,Math.min(1,1-distance)), NOT /2; or leave as-is.
- **Operation cast defeats type safety + no validation** (medium, indexer.ts normalize L161-164). `as unknown as IndexedEvent` + checkpoint always 0n (never from RPC) -> bigintMax checkpoint ordering no-op. Root cause of findings 2.2/3-numeric/3-vector. Fix: per-kind decoder validates+converts; populate checkpoint from RPC.
- **claude-sdk + eliza adapters empty stubs** (low, missing-feature, both index.ts). Export only version const, no impl; declare heavy deps never imported. Zero consumers. Documented post-hackathon drop. Fix: README not-implemented note OR drop unused deps.

### web-dashboard
- **Bad/errored vaultId renders fake SAMPLE_VAULT numbers** (medium, dashboard-shell.tsx 95-105, 129-146). Never checks liveQuery.isError -> error -> live=null -> all metrics fall back to SAMPLE_VAULT ($62,379, '73' artifacts, '1.0.0'). User pasting wrong id sees fabricated treasury as real. Mutations Move-VM-gated -> deception not fund loss. Fix: render error card when forcedVaultId set + isError; gate sample fallback to no-forcedVaultId preview.
- **u64 amounts cast to JS number -> precision loss** (medium, live-events.ts 279-280, 191). Number(rawAmount) on u64 MIST; >2^53 rounds (10M SUI = 1e16 MIST). NAV replay * price -> wrong. Rest of repo uses bigintField. Fix: keep bigint thru TimelineEntry; divide-by-decimals on bigint before Number().
- **zkLogin aud/iss/exp never validated client-side** (medium, zklogin.ts 199-275). Only nonce checked; no aud===GOOGLE_CLIENT_ID, iss, exp. exp not even in DecodedIdToken type. Token confusion / stale reuse not caught locally (prover gates final). Fix: assert aud/iss/exp after decode before salt/proof; add exp to type.
- **zkLogin user salt + jwt + ephemeral secret plaintext localStorage** (low, zklogin.ts 130-142, 102-105). Salt leak breaks unlinkability; XSS exfils signing identity until maxEpoch (~24h). Fix: salt -> Enoki server; ephemeral secret -> sessionStorage.
- **memwal-proxy unauthenticated public relay** (low, route.ts 54-110). Forwards any method/path/headers to fixed RELAYER_BASE, no origin/auth/rate-limit, uncapped arrayBuffer body. Not SSRF (host fixed, segments encoded); MemWal signed-envelope blocks tenant-forgery. Real harm = anonymizing relay + mem-DoS. Fix: cap body size, path allowlist, same-origin/rate-limit, strip cookie/auth headers.
- **Treasury loader sequential N+1 RPC** (low, vault-state.ts 212-242). Serial getDynamicFieldObject + getCoinMetadata per coin, every 30s refetch. Fix: Promise.all + cache immutable getCoinMetadata.
- **Publish form bundle-size cap only on source file, not bundled bytes** (low, strategy-bundler-panel.tsx 79+95-135). MAX_SOURCE_BYTES only on file upload, not paste/esbuild output. Oversized bundle committed on-chain + fetched every tick. Fix: cap encoded source length + bundle.bytes.length pre-publish.

### infra-ci-docs
- **debug-memwal.mjs hardcodes real contributor .key path + live account/namespace** (medium, scripts/debug-memwal.mjs 8-13). `/home/suyashagrawal/Downloads/synapse-session-ca1cafc7.key` + live ACCOUNT 0x9366ed4d... + NAMESPACE. PII + live testnet ids in git history (commit 4470cce). Excluded from scan (debug-*.mjs glob). No key bytes committed (file external). Fix: delete + git filter-repo to scrub history.
- **derive-session-addr.ts JSON-key path broken** (medium, scripts/derive-session-addr.ts 11-18). Prepends literal 'suiprivkey' to base64 -> invalid bech32 -> fromSecretKey throws. Dashboard writes plain base64 (no prefix). README verify step fails for JSON .key. Fix: base64-decode to 32 bytes like runtime/keypair.ts; OR prefer json.suiPrivateKey field.
- **README claims indexer triggers MemWal invalidation + Walrus eviction on revoke — unimplemented** (medium, README.md:134). Indexer src zero memwal/evict logic; only classifies AgentRevokedEvent into timeline string. MemWal SDK 0.0.3 no forget API, Walrus immutable. On-chain revoke (funds+action gate) IS real; only memory-eviction fiction. Fix: soften README to audit-log-only OR impl relayer invalidation subscriber.
- **Forbidden-pattern scan skips indexer + 3 adapters** (low, check-forbidden-patterns.sh 22-26). ROOTS = vault/client/memwal-bridge only. indexer (network-facing) + adapters exempt; indexer uses console.log 6x; banner carve-out comment vacuous (file never scanned). No active leak. Fix: add indexer/adapters src to ROOTS + real allowlist for banner.
- **push-secrets.sh raw key via --secret-string CLI arg** (low, push-secrets.sh 44-51,63-70). Plaintext key in argv -> ps aux/proc readable during call on shared host. Fix: file:// form via process substitution / 600-perm temp + trap rm.
- **.env.example documents ~8 of ~30 env vars** (low, .env.example vs config.ts). Missing economically-relevant SYNAPSE_DRIFT_THRESHOLD, SLIPPAGE_TOLERANCE, DEEPBOOK_POOL_ID, REFUEL_*, WAL_*, SEAL_*, STRATEGY_REGISTRY_JSON. Safe defaults (testnet pool/0.5 weight) -> no crash but mainnet operator carries testnet pool unknowingly. Fix: add commented tuning/refuel/Seal sections w/ defaults, flag mainnet-critical.
- **claude-sdk + eliza stubs declare heavy deps + packaged/built** (low, both index.ts). Version-const only; declare @anthropic-ai/claude-agent-sdk ^0.2.139, @elizaos/core ^1.7.2; in workspaces + Dockerfile COPY -> npm ci pulls trees for zero code. Documented drop (README:217). Fix: remove from workspaces/Dockerfile OR strip deps.
- **indexer in-memory only + pkg description overclaims** (low, indexer.ts:59). Flat in-mem array lost on restart (Phase-3 Postgres). package.json desc claims MemWal+Walrus blob lifecycle correlation; only Sui events indexed. Fix: persist cursor+events; correct desc to "Sui synapse_core events -> GraphQL views (in-memory v1)".
- **Fargate assignPublicIp:true on PUBLIC subnet despite 'no public IP' comment** (low, vault-runtime-stack.ts 143-150). Default VPC (no NAT) REQUIRES public IP for egress -> comment contradicts config (config correct). Default SG no inbound -> exposure none. Fix: correct comment; optional PRIVATE_WITH_EGRESS + NAT.

---

## 4. Missing Features / Incompleteness Inventory

**Stubs (no impl):**
- claude-sdk + eliza adapters — version-const only, heavy deps declared, zero consumers. Documented post-hackathon drop (README:217). [low]

**In-memory-only (no persistence):**
- Indexer storage = flat in-mem array `events[]` + cursors Map. Lost on restart -> genesis re-scan. Phase-3 Postgres deferred. [medium cursor, low events]
- Per-field event validation deferred to Phase 3 (`as unknown as IndexedEvent` cast). [medium]

**Documented-but-unimplemented:**
- README:134 "indexer triggers MemWal invalidation + Walrus eviction on revoke" — NO impl anywhere; MemWal SDK 0.0.3 no forget API, Walrus immutable. [medium]
- tick_failed AlertEvent enum + no-tick watchdog (run.ts comment) — declared, never emitted/implemented. [low]
- total_aum_committed reputation metric — accessor + event exist, always fed 0. Marketplace default sort uses it. [medium]
- Walrus-loader publisher allowlist — parsed but never enforced on exec path (line 69 "advisory"). [part of medium sandbox finding]
- node:vm strategy sandbox — documented header, not implemented. [part of medium sandbox finding]
- Mainnet DeepBook trading — config supports walrusNetwork:'mainnet' but executor testnet-pinned (zero-DEEP + hardcoded testnet pkg). [low]
- langgraph listNamespaces maxDepth/matchConditions — BaseStore spec params ignored. [low]

**Validation gaps (Move VM catches at submit, poor DX):**
- newAgent/buildMintPTB no client-side expiry/spend/address validation. [low]
- recordTickPerformance no u64 range guard. [low]

---

## 5. Subsystem Health Table

| Subsystem | Grade | Verdict |
|---|---|---|
| move-core | B | Gating model sound; royalty path bypasses spend cap (high) + reputation forgeable; test coverage thin on epoch/expiry. |
| move-seal-econ | B- | Seal confidentiality sound; economic inputs (royalty profit, alpha) untrusted -> session over-privileged on value; aum metric dead. |
| sdk-client | D | PTBs field-correct BUT pkg imports nonexistent @mysten/sui v2.16.2 (unbuildable) + session-key gen corrupts secret (high). |
| vault-runtime | C+ | Kill-switch + redaction solid; alpha snapshot pre-trade + MemWal-fail kill-switch (high) corrupt reputation/royalty; swap-tag/oracle/sandbox mediums. |
| strategies-ai | C+ | Weight clamp solid; Claude call uses nonexistent API params (permanent silent noop) + prompt injection via recalled facts (medium). |
| indexer-adapters | F | Indexer non-functional (snake/camel field mismatch, critical) — all vault views empty; tombstone delete broken (high); search pagination wrong. |
| web-dashboard | B- | PTBs/inputs/XSS solid; timeline never paginates -> wrong NAV (high); fake SAMPLE_VAULT on bad id; u64 precision loss; zkLogin gaps. |
| infra-ci-docs | C | Secret hygiene mostly solid; CI runs no Move tests + no dashboard build (high) -> money/access-control + UI ship uncaught; doc/script holes. |

NOTE: strategies-ai Claude-API-params defect (non-standard thinking:{type:'adaptive'} + output_config json_schema not in Messages API -> request errors -> permanent silent noop, advisor never trades) appears in subsystem summary as a real headline-feature defect but is NOT in the verified-findings list passed to me. Flagged for traceability; not scored above beyond summary mention.

---

## 6. Prioritized Remediation Plan

**P0 — block release (fund loss / core-broken):**
1. [ ] pay_strategist_royalty: charge vs per-epoch budget OR derive profit on-chain from NAV high-water-mark; kill caller-supplied profit_amount. (agent.move 438-475) — HIGH x2
2. [ ] Indexer normalize(): per-kind snake->camel decode + BigInt u64 + Uint8Array vector<u8> + TypeName `.name` extract + populate checkpoint. (indexer.ts 147-165) — CRITICAL + 2 medium + 1 quality, all same root
3. [ ] client pkg: migrate @mysten/sui v2.16.2 -> real v1.x surface; regenerate lockfile. — HIGH
4. [ ] session-key.ts generateSessionKey: use decodeSuiPrivateKey; add round-trip test. (L42-46) — HIGH

**P1 — correctness/reputation/availability (pre-prod):**
5. [ ] runtime: snapshot POST-trade holdings (derive from parseExecutedTrades) before savePreviousTick. — HIGH
6. [ ] runtime: try/catch rememberStrategyOutcome + move savePreviousTick before remember, both paths. — HIGH
7. [ ] langgraph: tombstone resolve by max writtenAt per (namespace,key) in get+search; address recall top-K miss. — HIGH
8. [ ] dashboard loadLiveTimeline: paginate via nextCursor (mirror owned-vaults.ts). — HIGH
9. [ ] CI: add `sui move test` job + web/dashboard next build + tsc typecheck; gate merge. — HIGH
10. [ ] record_tick / record_tick_performance: bound alpha per tick (MAX_ALPHA_BPS=5000) + XOR pos/neg + per-epoch tick cap OR derive from NAV. — medium x2
11. [ ] executor: canonicalize swap type-args for direction=1. — medium
12. [ ] oracle: Pyth staleness/conf gate (drop feed >60s -> DeepBook mid). — medium
13. [ ] record_swap: emit real coin::value output_amount + clamp zero-abort. — medium

**P2 — security hardening / data integrity:**
14. [ ] walrus-loader: node:vm sandbox + enforce publisher allowlist + keep session key out of reachable env. — medium
15. [ ] llm-advisor: fence recalled facts as untrusted-DATA + cap length + feed only own-vault structured facts. — medium
16. [ ] indexer GraphQL: cap events limit + graphql-armor + bind 127.0.0.1 default + rate-limit. — medium
17. [ ] langgraph search: over-fetch recall (offset+limit) then slice. — medium
18. [ ] total_aum_committed: thread real AUM OR drop field + change marketplace default sort off 'aum'. — medium
19. [ ] dashboard: error card on bad/errored vaultId (no SAMPLE_VAULT fallback). — medium
20. [ ] dashboard: bigint thru TimelineEntry (u64 precision). — medium
21. [ ] zkLogin: validate aud/iss/exp client-side. — medium
22. [ ] indexer cursor persistence (file/sqlite) + flush on stop. — medium
23. [ ] Remove debug-memwal.mjs + filter-repo scrub; fix derive-session-addr.ts; soften README:134 revoke claim. — medium x3

**P3 — quality / DX / docs / low-risk:**
24. [ ] Move: add !revoked guard to set_operational_cap/set_walrus_consent/remove_approved_package; fix operational_spent_this_epoch accessor; add epoch-rollover/EExpired/EInsufficientBalance tests.
25. [ ] Move: doc royalty floor; explicit seal_approve len>=32 + granular-revocation variant.
26. [ ] client: assertValidPackageId in target(); newAgent/recordTickPerformance input guards; verifyKeyServers default true/network-derived; sealIdForAddress normalize.
27. [ ] runtime: split retry build/submit + digest probe; parseArtifactSlot return 0n on miss; tick_failed watchdog or remove enum; per-network DeepBook resolver / mainnet fail-fast; SUI-balance pre-check before royalty moveCall; redactBindings string-leaf scan at depth cutoff.
28. [ ] strategies: usdToAtomic Number.isFinite guards (4 files) + wrap rebal.evaluate; bytesToAsciiHex explicit encode + fatal:true; @anthropic-ai/sdk -> optionalDependencies + serverExternalPackages; clamp rec.rationale (uncertain — verify need first).
29. [ ] indexer: ring-buffer cap + per-vault indexes; correct package.json desc; README/dep cleanup for claude-sdk/eliza stubs.
30. [ ] dashboard: Promise.all treasury loader + cache metadata; memwal-proxy body cap + path allowlist; salt->Enoki + ephemeral->sessionStorage; publish form bundle-byte cap.
31. [ ] infra: add indexer/adapters to forbidden-pattern ROOTS; push-secrets.sh file:// form; expand .env.example; fix Fargate comment.

NOTE: items 10 (record_tick) appears in both move-core + move-seal-econ findings — same on-chain code, fix once.