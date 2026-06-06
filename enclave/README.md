# Synapse Decision Enclave

Runs the AI advisor inside an **attested AWS Nitro enclave** (deployed via
[Marlin Oyster](https://blog.marlin.org/scaling-confidential-compute-on-sui-nautilus-and-marlin-oyster-integration),
no self-managed AWS). Each tick the enclave reasons over the market + recalled
memory, then signs a `DecisionPayload` with a secp256k1 key whose public key is
bound to the enclave's reproducible-build PCR measurement by the Nitro
attestation document. `synapse_core::decision_attestation` verifies that
signature on-chain **before the rebalance swap is allowed to execute**.

This makes "verifiable AI decision" literally true: the trade cannot run on a
forged or tampered decision, and the Anthropic + session keys live inside the
enclave, never in a host env var.

## What it proves (and doesn't)

- **Proves:** the decision was produced by the published enclave code (PCRs
  registered on-chain), over the inputs whose hash it signed, and is unaltered.
- **Does not prove:** that the supplied market/memory inputs are themselves
  truthful (that is the oracle's job — Pyth/DeepBook), or that the LLM's
  judgement is good. Attestation covers **execution authenticity**, not oracle
  truth or model quality.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness |
| GET | `/public-key` | compressed secp256k1 pubkey hex (for `register_enclave`) |
| POST | `/decide` | `{ vaultId, epoch, input }` → `{ decision, signature, timestamp_ms }` |

The Oyster runtime additionally exposes `/attestation/hex` for on-chain
registration.

## Local run

```bash
npm install
# 32-byte secp256k1 dev key
head -c 32 /dev/urandom > signing-key
node src/index.js ./signing-key
```

**LLM strategies (model A):** the enclave server does **not** need a platform
Anthropic key. Each vault owner supplies their own key when enabling hosted
runtime; Fargate forwards it on every `POST /decide` as `anthropicApiKey` so
Claude usage bills to the DAO, not Synapse. For local `/decide` testing you can
pass `anthropicApiKey` in the JSON body or set `ANTHROPIC_API_KEY` in the shell.

## Deploy to Oyster + register on-chain

> Prereqs: a wallet funded with the Oyster payment token, the `oyster-cvm` CLI,
> and a Docker registry you can push to.

1. **Build + push the image (digest-pinned, reproducible).**
   ```bash
   docker build -t <you>/synapse-decision-enclave:v1 .
   docker push <you>/synapse-decision-enclave:v1   # note the @sha256 digest
   ```
   Update `docker-compose.yml` `image:` to the digest-pinned reference. For a
   fully reproducible PCR, build under the upstream Nix template
   (`marlinprotocol/sui-oyster-demo` `nix.sh` / `build.nix`) instead of a plain
   `docker build`.

2. **Deploy to Oyster** (operators provision the Nitro hardware; pay from your
   wallet):
   ```bash
   oyster-cvm deploy \
     --wallet-private-key $WALLET_KEY \
     --docker-compose ./docker-compose.yml \
     --instance-type c6g.xlarge \
     --duration-in-minutes 120
   # capture ENCLAVE_URL (public IP) from the output
   ```

3. **Read the PCRs + register on-chain.** Fetch the attestation:
   ```bash
   curl $ENCLAVE_URL:1301/attestation/hex      # attestation document
   curl $ENCLAVE_URL/public-key                # sanity check the pubkey
   ```
   - `enclave::update_pcrs` on the `EnclaveConfig<DECISION_ATTESTATION>` with the
     real PCR0/1/2/16 (the placeholders set at publish time are `0x00`).
   - `enclave::register_enclave<DECISION_ATTESTATION>(config, attestation_doc)` —
     verifies the PCRs + extracts the pubkey, sharing the `Enclave` object.
   Record the resulting `Enclave` object id; the runtime needs it.

4. **Point the runtime at the enclave** — set `SYNAPSE_ENCLAVE_URL` and
   `SYNAPSE_ENCLAVE_OBJECT_ID` (see `sdk/packages/vault` runtime config). The
   runtime calls `/decide`, attaches the signature to the rebalance PTB via
   `decision_attestation::attest_decision`, and the swap aborts unless it
   verifies.

## Rebuilds

Any change under `src/` or to the base image changes the PCRs. Rebuild, redeploy,
then `enclave::update_pcrs` + `register_enclave` again. Old `Enclave` objects can
be retired with `destroy_old_enclave`.

## Fixture

`scripts/gen-fixture.mjs` regenerates the deterministic Node-signed fixture that
`synapse_core::decision_attestation::verifies_node_signed_decision` asserts
against — the guard that the Node and Move BCS layouts never drift.
