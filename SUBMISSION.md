# Synapse Vault — Walrus Track Executive Summary

**Sui Overflow 2026 · Walrus Specialized Track**

| | |
|---|---|
| **Team** | Synapse Labs |
| **Repo** | [github.com/SuyashAlphaC/Synapse](https://github.com/SuyashAlphaC/Synapse) |
| **Live demo** | [app.synapsevault.xyz](https://app.synapsevault.xyz) |
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

| Proof | Reference |
|---|---|
| Cross-agent MemWal read | tx `AQQZhQRQZ8vK1Y7zPrxaGT7MS9cRkVAoXLYHvSSEDzRm` |
| Nautilus decision attestation | tx `7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe` |
| Seal policy package | `0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a` |
| Messaging end-to-end | `examples/messaging-demo/` |

---

## 60-second judge walkthrough

1. Open **[app.synapsevault.xyz](https://app.synapsevault.xyz)** → marketplace or an existing vault.
2. **Audit timeline** — on-chain ticks (swap, noop, artifact publish, coordination).
3. **MemWal recall panel** — semantic query → decrypted hits → Walrus blob links.
4. **Artifacts panel** — fetch Walrus markdown; SHA-256 verified against chain.
5. **Coordination** — cross-agent reads / messaging channel status.
6. Clone repo → `npm install` → `cd web/dashboard && npm run dev` for full mint path.

---

## Security posture

Treasury safety does **not** depend on Walrus or MemWal honesty — only on Move policy gates. Walrus provides **durability, portability, and audit integrity** (hash on-chain). Full analysis: **[THREAT_MODEL.md](./THREAT_MODEL.md)**.

Honest gaps: messaging requires channel MemberCap provisioning; attestation proof uses a dev enclave (production Nitro/Oyster documented); external audit before mainnet.

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
