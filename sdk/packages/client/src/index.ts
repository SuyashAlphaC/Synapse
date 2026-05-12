/**
 * @synapse-core/client — TypeScript client for Synapse Core on Sui.
 *
 * Phase 2 of the implementation plan. This file is the export root for:
 *   - `./agent`     — mint/fund/revoke/governance PTB builders
 *   - `./wallet`    — spend/withdraw/drain PTB builders
 *   - `./artifacts` — publish (Walrus upload + on-chain register), fetch, burn
 *   - `./zklogin`   — Google OAuth → ephemeral key → zkLogin proof flow
 *
 * Implementation lands per `docs/superpowers/plans/2026-05-12-synapse-core.md`.
 */

export const SYNAPSE_PACKAGE_ID_PLACEHOLDER = '0x0';
