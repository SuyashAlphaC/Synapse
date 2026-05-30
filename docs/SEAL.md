# Seal-encrypted artifacts

Synapse can Seal-encrypt a vault's audit reports before they go to Walrus, so
the rationale/holdings blob is opaque to anyone but the vault's session/owner
key. Access is gated on-chain by `synapse_seal::policy::seal_approve`.

Encryption is **off by default** — set `SYNAPSE_SEAL_PACKAGE_ID` to turn it on.
The browser in-tab runtime never sets it, so it always uploads plaintext.

## What's already done (code, verified)

- `move/synapse_seal` — `seal_approve(id, ctx)` identity-prefix policy
  (`move build` + unit test pass).
- `@synapse-core/client/seal` — `buildSynapseSealClient`, `sealIdForAddress`,
  `SEAL_TESTNET_KEY_SERVERS` (both key servers verified live), `sealEncrypt`,
  `sealDecrypt`. Encryption proven against the live testnet key servers
  (opaque ciphertext, no plaintext leak).
- Runtime: when `SYNAPSE_SEAL_PACKAGE_ID` is set, both tick paths Seal-encrypt
  the report and record the artifact with `seal_encrypted = true` + the real
  ciphertext sha256/size.
- Dashboard: the Artifacts panel shows a **Decrypt** action for sealed
  artifacts (pick `.key` → fetch ciphertext → decrypt → show plaintext).

## Published

`synapse_seal` is published on **testnet** (first-version, module `policy`):

```
0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a
```

This is the default `SYNAPSE_SEAL_PACKAGE_ID` /
`NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID`. To re-publish (fresh v1 — Seal requires
a first-version namespace):

```bash
cd move/synapse_seal
sui client publish --gas-budget 100000000
```

Copy the new package ID from the `Published Objects` entry.

2. **Configure both sides** with that package ID:

   - Runtime / headless container: `SYNAPSE_SEAL_PACKAGE_ID=0x<pkg>`
     (optional `SYNAPSE_SEAL_KEY_SERVERS=0x..,0x..` to override the defaults).
   - Dashboard: `NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID=0x<pkg>` in `.env.local`.

3. **Tick** a vault (CLI or headless) → it publishes a Seal-encrypted report.
   On-chain `ArtifactPublishedEvent.seal_encrypted` is `true`; the Walrus blob
   is ciphertext (opening the raw blob shows binary, not markdown).

4. **Decrypt** in the dashboard: open the sealed artifact in the Artifacts
   panel, pick the vault's `.key`, click **Decrypt**. The session key signs a
   Seal `SessionKey`; the key servers dry-run `seal_approve` (which passes only
   because the session address is the identity prefix) and release the shares.

## Notes

- Key servers can rotate; if decryption fails with a key-server error, confirm
  the current testnet server object IDs against the Seal docs and set
  `SYNAPSE_SEAL_KEY_SERVERS` / `NEXT_PUBLIC_*` accordingly.
- The Seal identity is `<session-address bytes> || <plan-id bytes>`, so only
  the vault's current session key decrypts. Rotating the session key rotates
  decryption access for future artifacts.
