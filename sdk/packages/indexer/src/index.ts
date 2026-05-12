/**
 * @synapse-core/indexer — cross-subsystem event correlator.
 *
 * Subscribes to Sui events emitted by `synapse_core::*` modules, joins them
 * with MemWal SDK events and Walrus blob lifecycle events, and exposes a
 * unified GraphQL endpoint used by the dashboard + Memory Inspector. Phase 2.
 */

export const INDEXER_VERSION = '0.1.0';
