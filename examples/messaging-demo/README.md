# Sui Stack Messaging demo

Agent-to-agent message — **stored on Walrus, Seal-encrypted** via Sui Stack
Messaging — correlated **on-chain** through `synapse_core::messaging_bridge`.

This closes the third named Walrus-track reference (alongside Seal and Walrus
Sites): real `@mysten/messaging` send + on-chain send/receive attestation.

## Why a separate package

`@mysten/messaging@0.3.0` pins `@mysten/sui@^1.x` + `@mysten/seal@^0.9`. The
main Synapse SDK runs on **sui 2.x / seal 1.1** — major-version incompatible.
Rather than fork the whole codebase, the Sui Stack Messaging leg is isolated
here with its own compatible deps. The on-chain audit leg uses plain
`Transaction` calls to `synapse_core`, so no Synapse SDK import is needed and
the two sui versions never mix.

## Flow (all real, no mocks)

1. Owner creates a Sui Stack Messaging **channel** with the recipient as a
   member — channel + messages stored on **Walrus**, Seal-encrypted.
2. Owner **sends one message** into the channel (real Walrus write).
3. On-chain audit:
   - `agent::attach_messaging(vault, channel, channel)` — owner, one-time.
   - `messaging_bridge::record_send(senderVault, channel, digest)` — sender
     session key.
   - `messaging_bridge::record_receive(recipientVault, channel, digest)` —
     recipient session key.

   `MessageSentEvent` + `MessageReceivedEvent` are correlated by the same
   message digest.

## Run

```bash
cd examples/messaging-demo
npm install

export SYNAPSE_PACKAGE_ID=0x…           # synapse_core
export OWNER_KEY=suiprivkey…            # vault owner (creates channel, sends, attaches)
export SENDER_VAULT=0x… RECIPIENT_VAULT=0x…
export SENDER_SESSION_KEY=suiprivkey… RECIPIENT_SESSION_KEY=suiprivkey…
export MESSAGE="cross-agent signal: rotate 5% SUI→USDC next epoch"

npm run send
```

Needs the owner wallet + both session addresses funded with testnet SUI
(channel creation, message send, and three audit txs all cost gas), and the
owner needs WAL for Walrus storage.

## Status

**Code-complete, typecheck-verified** against the real `@mysten/messaging`
typed API (`npm run typecheck` is clean). Not yet executed end-to-end —
channel creation needs a funded owner wallet, so the live run is operator-side
(same model as the Seal publish and the cross-agent-read CLI).

Known live-run notes:
- The channel encryption key is taken as the freshly-created channel's first
  key (`version: 0`); if a multi-key rotation path is exercised, read the
  current version from the channel object first.
- `attach_messaging` is idempotent here (re-runs tolerate `EMessagingAlreadySet`).
