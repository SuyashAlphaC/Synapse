/// Seal access-control policy for Synapse sealed artifacts.
///
/// Seal decryption is gated by a `seal_approve*` function in the package
/// whose id-namespace was used at encryption time: the key servers dry-run a
/// PTB that calls it, and only release key shares if it does not abort.
///
/// This package provides the simplest sound policy — identity-prefix access.
/// An artifact is encrypted under `id = <authorized-address bytes> || <suffix>`.
/// `seal_approve` aborts unless the PTB sender's address bytes are a prefix of
/// `id`. Because only a Seal `SessionKey` created for that address can produce
/// a PTB whose sender matches, only the vault's session/owner key can decrypt
/// the vault's sealed artifacts. No dependency on `synapse_core`, so this
/// publishes independently and never forces a core upgrade.
module synapse_seal::policy {
    use std::bcs;

    /// The PTB sender is not authorized to decrypt this identity.
    const ENoAccess: u64 = 0;

    /// Seal key-retrieval hook. Called (dry-run) by the key servers during
    /// decryption; aborts when `ctx.sender()` is not the authorized address
    /// encoded as the prefix of `id`.
    entry fun seal_approve(id: vector<u8>, ctx: &TxContext) {
        assert!(is_prefix(bcs::to_bytes(&ctx.sender()), id), ENoAccess);
    }

    /// True iff `prefix` is a prefix of `full`.
    fun is_prefix(prefix: vector<u8>, full: vector<u8>): bool {
        let plen = vector::length(&prefix);
        if (plen > vector::length(&full)) { return false };
        let mut i = 0;
        while (i < plen) {
            if (*vector::borrow(&prefix, i) != *vector::borrow(&full, i)) { return false };
            i = i + 1;
        };
        true
    }

    #[test]
    fun prefix_matches_and_rejects() {
        let full = vector[1u8, 2u8, 3u8, 4u8];
        assert!(is_prefix(vector[1u8, 2u8], full), 100);
        assert!(is_prefix(full, full), 101);
        assert!(!is_prefix(vector[2u8], full), 102);
        assert!(!is_prefix(vector[1u8, 2u8, 3u8, 4u8, 5u8], full), 103);
    }
}
