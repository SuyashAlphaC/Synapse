# MemWal Credential Setup

1. Sign up at https://app.memwal.ai.
2. Create a MemWal account and copy the account ID.
3. Generate a delegate key and copy the hex secret.
4. In the dashboard mint flow, use the "Connect MemWal" step to paste:
   - `MemWal account ID`: the `0x...` account object ID.
   - `Delegate key (hex)`: the delegate secret used by the runtime.

Choosing "Skip - no memory" mints the Vault with empty `memwal_*` bytes. The runtime detects the missing MemWal config and runs without recall, while still writing Walrus audit artifacts and Sui action logs.

The dashboard stores the delegate key in browser `localStorage` under:

```text
synapse:memwal:<agentId>
```

This is acceptable for the testnet demo but not for production. A production runtime should keep delegate keys in an HSM, OS keychain, or a Seal-encrypted Walrus blob whose decryption policy is controlled by the Vault owner.
