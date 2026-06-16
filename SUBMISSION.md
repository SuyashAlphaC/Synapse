# Synapse Vault — Walrus Track Executive Summary

**Sui Overflow 2026 · Walrus Specialized Track**

| | |
|---|---|
| **Team** | Synapse Labs |
| **Repo** | [github.com/SuyashAlphaC/Synapse](https://github.com/SuyashAlphaC/Synapse) |
| **Live demo** | [synapse-kappa-sable.vercel.app](https://synapse-kappa-sable.vercel.app/) |
| **Demo video** | [YouTube (~7 min)](https://www.youtube.com/watch?v=R2g5HCLmApI) |
| **Attestation addendum** | [YouTube (~90 sec)](https://www.youtube.com/watch?v=GbzpgDedcWU) — Policy, hosted runtime, Suiscan `DecisionAttestedV2` + swap |
| **Memory inspector** | [synapse-kappa-sable.vercel.app/inspector](https://synapse-kappa-sable.vercel.app/inspector) (read-only, no wallet) |
| **Walrus Site** | `0x55c33a39757a4487ca8cebdaffd5b7b9f9ba9601456a82ef5f031c689ae0001a` |
| **Move package (v6)** | `0xe95241a800a97841e7676437cc83c9761e6d30e42ab8bdd590d49fd40e22a797` |

---

## One sentence

**Synapse Vault is a Walrus-native autonomous treasury where every tick recalls MemWal memory, reasons over it, executes under Move policy, publishes a hash-anchored Walrus audit artifact, coordinates with peer agents, and remembers the outcome — with the Move VM as the only authority that can move funds.**

---

## The problem

AI agents are everywhere, but **financial autonomy has no safe substrate**: hot wallets get drained, human-in-the-loop kills automation, and custodians reintroduce trust. Meanwhile, agents are **stateless and siloed** — they forget between runs, cannot share context, and leave no portable audit trail.

The Walrus track asks for the opposite: **durable memory, verifiable files, multi-agent coordination, and long-running workflows.** Synapse delivers all four inside a **production treasury tick** that lands on Sui testnet today.

---

## Why this is a strong Walrus submission

| Track requirement | Synapse delivery |
|---|---|
| Long-term verifiable memory | MemWal `recall` / `remember` **every tick**; dashboard recall panel runs the same query as the runtime |
| Persistent files on Walrus | Markdown audit report **every tick** + on-chain `ArtifactRef` (blob id + SHA-256) |
| Dev tooling | `@synapse-core/adapter-langgraph`, Walrus strategy publisher, headless runtime + AWS Fargate hosting |
| Long-running workflow | EventBridge-scheduled Fargate ticks; state resumes from MemWal after restart |
| Multi-agent coordination | Shared MemWal namespace + on-chain `CrossAgentReadEvent`; Sui Stack Messaging with `record_send` / `record_receive` |
| Artifact-driven workflows | Peers reuse Walrus audit artifacts via cross-agent recall |
| Seal | Private strategy params + messaging payloads; `synapse_seal` policy on testnet |
| Walrus Sites | This marketing site is served from Walrus |

**Differentiator:** Most entries attach Walrus to a demo agent. Synapse makes Walrus the **default data plane** of a real financial agent whose trades are policy-gated on-chain.

---

## The Walrus-native tick loop

```
RECALL    MemWal memory + cross-agent peer facts (+ optional messaging inbox)
REASON    TypeScript / LangGraph / LLM / attested Nautilus enclave
ACT       One PTB: [attest?] → policy gate → DeepBook swap → royalty → log
PUBLISH   Upload rationale → Walrus; SHA-256 anchored on-chain
COORDINATE  Emit rebalance signal to peers (Messaging + record_send)
REMEMBER  Persist outcome → MemWal for next tick
```

Implementation: `sdk/packages/vault/src/runtime/runtime.ts`

---

## Integrated features (single product)

- **Move policy envelope** — spend cap, allowlist, expiry, one-tx revoke; AI never custodies funds
- **DeepBookV3 composability** — swaps inside the same PTB as audit + performance recording
- **Strategy marketplace** — on-chain hire, Walrus-loaded bundles (hash-verified), royalty in PTB
- **MemWal + cross-agent reads** — attested on reader's chain (`CrossAgentReadEvent`)
- **Sui Stack Messaging** — Seal + Walrus payloads; on-chain correlator in tick loop
- **Nautilus attestation (opt-in)** — enclave signs decision; Move verifies before swap
- **Seal private artifacts** — dashboard decrypt path verified on testnet
- **Hosted runtime** — per-vault AWS Fargate + Secrets Manager (design-partner vaults live)

---

## Live proofs (testnet)

### Hosted demo vaults (AWS Fargate runtime, EventBridge ticks)

| Vault | AgentIdentity | Notes |
|---|---|---|
| Primary | [`0x347dd8d7…ec65e8`](https://suiscan.xyz/testnet/object/0x347dd8d77d137042bdae4bc847e4dda798529bd0bf934115ca0395b6afec65e8) | MM Inventory v2 · attestation enabled · rebalance + messaging live |
| Secondary | [`0xbefc3142…68cf4`](https://suiscan.xyz/testnet/object/0xbefc3142c5138e07655485a984c031e18494f71279486b0dd01e949309268cf4) | Same strategy · shared messaging channel |

Strategy bundle (Walrus): `2UIzJtYptwlLqh8lzotjd046DaTFa4th3By7UXV4VLs` · Messaging channel: `0xe0177c44cb354ecbb08788ef8fd57992c2fb8dfc7e600bbc868cdbc1caef1b9d` · Nautilus enclave object: `0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be`

### On-chain proof transactions

| Proof | Reference |
|---|---|
| Live rebalance + coordination signal | [tx `2hU2arKC…`](https://suiscan.xyz/testnet/tx/2hU2arKSpg94N7C9AF36ED2ZKvDbgsfEYFE5R8trtpbH) (signal digest `89dGyHaVfJQpzaXbHaHvNzGKSVzLWKcM76WuyTa5rftW`) |
| Cross-agent MemWal read | [tx `AQQZhQRQ…`](https://suiscan.xyz/testnet/tx/AQQZhQRQZ8vK1Y7zPrxaGT7MS9cRkVAoXLYHvSSEDzRm) |
| Nautilus decision attestation | [tx `7TLfyS6a…`](https://suiscan.xyz/testnet/tx/7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe) (`DecisionAttested`) |
| Seal policy package | `0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a` |
| Messaging end-to-end | `examples/messaging-demo/` |

---

## Nautilus attestation proof

The main demo video focuses on Walrus memory, artifacts, and coordination. **Attestation is opt-in per vault** and verified on-chain — watch the [attestation addendum (~90 sec)](https://www.youtube.com/watch?v=GbzpgDedcWU) or follow the steps below.

### What attestation proves

The enclave signs `(code_hash ‖ decision_hash ‖ inputs_hash)`. Move `decision_attestation::attest_decision_v2` verifies the signature **in the same PTB** before `wallet::spend` allows a swap. If `requires_attestation` is on and no valid stamp exists this epoch, the PTB aborts with `ENotAttested`.

Honest scope: this demo uses a **dev enclave** (documented in [enclave/README.md](./enclave/README.md)). Production Nitro/Oyster path is documented; not the default hosted deployment yet.

### Verify in the dashboard (wallet required — vault owner)

1. Open [synapse-kappa-sable.vercel.app/dashboard](https://synapse-kappa-sable.vercel.app/dashboard) and connect the owner wallet.
2. Select vault **`0x347dd8d77d137042bdae4bc847e4dda798529bd0bf934115ca0395b6afec65e8`**.
3. **Policy bounds** → **Attested execution** should read **On** (“Every spend aborts unless a valid Nautilus enclave decision was attested this epoch”).
4. **Hosted runtime** → **Nautilus attestation** section should show **`nautilus ✓`** with enclave object **`0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be`**.

### Verify on-chain (no wallet)

Best proof — **attestation + swap in one PTB** ([`2hU2arKC…`](https://suiscan.xyz/testnet/tx/2hU2arKSpg94N7C9AF36ED2ZKvDbgsfEYFE5R8trtpbH)): open Suiscan → **Events** → `DecisionAttestedV2` then `SwapEvent`. [SuiVision Events tab](https://testnet.suivision.xyz/txblock/2hU2arKSpg94N7C9AF36ED2ZKvDbgsfEYFE5R8trtpbH).

Standalone attestation stamp: [tx `7TLfyS6a…`](https://suiscan.xyz/testnet/tx/7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe) (`DecisionAttested` only).

Enclave object: [`0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be`](https://suiscan.xyz/testnet/object/0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be)

### Attestation addendum video (~90 sec)

**[youtube.com/watch?v=GbzpgDedcWU](https://www.youtube.com/watch?v=GbzpgDedcWU)** — dashboard Policy + Hosted runtime + Suiscan event walkthrough. Companion to the [main demo](https://www.youtube.com/watch?v=R2g5HCLmApI).

---

## 60-second judge walkthrough

1. **Watch** the [demo video](https://www.youtube.com/watch?v=R2g5HCLmApI) — problem, live vault audit timeline, Walrus artifacts, MemWal recall, inspector, coordination.
2. **Attestation** — [addendum (~90 sec)](https://www.youtube.com/watch?v=GbzpgDedcWU) · [Suiscan proof tx](https://suiscan.xyz/testnet/tx/2hU2arKSpg94N7C9AF36ED2ZKvDbgsfEYFE5R8trtpbH) · [details](#nautilus-attestation-proof)
3. **Inspect on-chain** (no wallet): [synapse-kappa-sable.vercel.app/inspector](https://synapse-kappa-sable.vercel.app/inspector) → paste `0x347dd8d77d137042bdae4bc847e4dda798529bd0bf934115ca0395b6afec65e8` → audit timeline + Walrus artifact links.
4. **Verify txs** — rebalance [`2hU2arKC…`](https://suiscan.xyz/testnet/tx/2hU2arKSpg94N7C9AF36ED2ZKvDbgsfEYFE5R8trtpbH) · cross-agent read [`AQQZhQRQ…`](https://suiscan.xyz/testnet/tx/AQQZhQRQZ8vK1Y7zPrxaGT7MS9cRkVAoXLYHvSSEDzRm) · attestation [`7TLfyS6a…`](https://suiscan.xyz/testnet/tx/7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe).
5. **Explore dashboard** — connect wallet at [synapse-kappa-sable.vercel.app/dashboard](https://synapse-kappa-sable.vercel.app/dashboard) for owned vaults, MemWal recall panel, artifacts, and policy controls; or [mint](https://synapse-kappa-sable.vercel.app/mint) a new vault.
6. **Clone locally** — `npm install` → `cd web/dashboard && npm run dev` for full mint path.

---

## Security posture

Treasury safety does **not** depend on Walrus or MemWal honesty — only on Move policy gates. Walrus provides **durability, portability, and audit integrity** (hash on-chain). Full analysis: **[THREAT_MODEL.md](./THREAT_MODEL.md)**.

Honest gaps: messaging requires channel MemberCap provisioning; attestation proof uses a dev enclave (production Nitro/Oyster documented); external audit before mainnet; unattended production requires monitoring session gas and operational budget — the dashboard shows a **runtime gas** warning when ticks are likely failing.

---

## Documentation map

| Doc | Audience |
|---|---|
| [README.md](./README.md) | Architecture, runbook, requirement matrix |
| [THREAT_MODEL.md](./THREAT_MODEL.md) | Judges, compliance, auditors |
| [AUDIT.md](./AUDIT.md) | Internal audit + remediation |
| [enclave/README.md](./enclave/README.md) | Nautilus deployment |
| [web/site/](./web/site/) | Walrus Sites marketing (this submission's front door) |

---

*Synapse Labs · Sui Overflow 2026 · Walrus Track*
