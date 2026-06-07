/**
 * Sample data shapes for the demo dashboard. In production these come from
 * the @synapse-core/indexer GraphQL endpoint. We use the SAME field names
 * here so swapping to live data is a single import change.
 */

export interface Vault {
  id: string;
  name: string;
  owner: string;
  sessionAddr: string;
  strategyName: string;
  strategyVersion: string;
  status: 'active' | 'expired' | 'revoked' | 'draft';
  navUsd: number;
  pnl24hUsd: number;
  pnl24hPct: number;
  inceptionTs: number;
  expiryEpoch: bigint;
  managementFeeBps: number;
  performanceFeeBps: number;
  holdings: Array<{
    symbol: string;
    typeTag: string;
    amount: number;
    priceUsd: number;
    valueUsd: number;
    accentColor: string;
  }>;
}

export interface TimelineEntry {
  id: string;
  vaultId: string;
  kind:
    | 'agent_minted'
    | 'agent_funded'
    | 'spend'
    | 'artifact_published'
  | 'cross_agent_read'
  | 'cross_agent_write'
  | 'message_sent'
    | 'message_received'
    | 'swap'
    | 'action_log'
    | 'agent_revoked';
  description: string;
  timestamp: number;
  txDigest: string;
  walrusBlobId?: string;
  amount?: number;
  amountUsd?: number;
  tokenSymbol?: string;
  counterparty?: string;
  accentColor?: string;
}

export const SAMPLE_VAULT: Vault = {
  id: '0x7c3a8e6b4d1f9c2a8b0e3d6f4a7c9b2e5d8f1a3c6b9e2d5f8a1c4b7e0d3f6a9c',
  name: 'Helios Treasury',
  owner: '0xa11ce0e9f8b7c6d5a4e3f2b1c0d9e8f7a6b5c4d3e2f1b0c9d8e7f6a5b4c3d2e1',
  sessionAddr: '0xbeef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
  strategyName: 'Conservative Rebalancer',
  strategyVersion: '1.0.0',
  status: 'active',
  navUsd: 1_247_582,
  pnl24hUsd: 8_341,
  pnl24hPct: 0.00672,
  inceptionTs: Date.now() - 1000 * 60 * 60 * 24 * 27,
  expiryEpoch: 2148n,
  managementFeeBps: 100,
  performanceFeeBps: 50,
  holdings: [
    {
      symbol: 'SUI',
      typeTag: '0x2::sui::SUI',
      amount: 412_580.43,
      priceUsd: 1.5121,
      valueUsd: 624_064,
      accentColor: '#4A9BFF',
    },
    {
      symbol: 'USDC',
      typeTag: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
      amount: 623_518,
      priceUsd: 1,
      valueUsd: 623_518,
      accentColor: '#5BD49C',
    },
  ],
};

export const SAMPLE_TIMELINE: TimelineEntry[] = [
  {
    id: 't-001',
    vaultId: SAMPLE_VAULT.id,
    kind: 'swap',
    description: 'Conservative Rebalancer · sell 24,170 SUI for 36,602 USDC',
    timestamp: Date.now() - 1000 * 60 * 12,
    txDigest: '8h4Y3kQfPa9bC2vN1mZxL5pE6tR8wQ7uG3yA2sF1xV9c',
    amount: 24170,
    amountUsd: 36602,
    tokenSymbol: 'SUI→USDC',
    accentColor: '#FF6B35',
  },
  {
    id: 't-002',
    vaultId: SAMPLE_VAULT.id,
    kind: 'artifact_published',
    description: 'Audit report eth_outlook_2026_05_13.md · 8.2 KB',
    timestamp: Date.now() - 1000 * 60 * 12 - 6000,
    txDigest: '7g3X2jPeOZ8aB1uM0lYwK4oD5sQ7vP6tF2xZ1rE0wU8b',
    walrusBlobId: 'Qmd7y5ZWZmYjLnRsLvqB3kPbS4u6Y8a2c9dE5fG3hI1jK',
    tokenSymbol: 'walrus',
    accentColor: '#9D7AEB',
  },
  {
    id: 't-003',
    vaultId: SAMPLE_VAULT.id,
    kind: 'spend',
    description: 'OpenAI proxy contract · GPT-5 inference call',
    timestamp: Date.now() - 1000 * 60 * 14,
    txDigest: '6f2W1iNdNY7zA0tL9kXvJ3nC4rP6uO5sE1wY0qD9vT7a',
    amount: 0.14,
    amountUsd: 0.14,
    tokenSymbol: 'USDC',
    counterparty: '0xopenai-proxy',
    accentColor: '#5BC0EB',
  },
  {
    id: 't-004',
    vaultId: SAMPLE_VAULT.id,
    kind: 'action_log',
    description: 'Strategy diagnosis · 1.21% SUI drift detected · threshold 1.00%',
    timestamp: Date.now() - 1000 * 60 * 15,
    txDigest: '5e1V0hMcMX6yZ9sK8jWuI2mB3qO5tN4rD0vX9pC8uS6z',
    accentColor: '#F7C543',
  },
  {
    id: 't-005',
    vaultId: SAMPLE_VAULT.id,
    kind: 'message_received',
    description: 'Inbox: market-data oracle · price refresh',
    timestamp: Date.now() - 1000 * 60 * 60,
    txDigest: '4d0U9gLbLW5xY8rJ7iVtH1lA2pN4sM3qC9uW8oB7tR5y',
    accentColor: '#FF8FA3',
  },
  {
    id: 't-006',
    vaultId: SAMPLE_VAULT.id,
    kind: 'swap',
    description: 'Conservative Rebalancer · buy 18,400 SUI with 27,800 USDC',
    timestamp: Date.now() - 1000 * 60 * 60 * 6,
    txDigest: '3c9T8fKaKV4wX7qI6hUsG0kZ1oM3rL2pB8tV7nA6sQ4x',
    amount: 18400,
    amountUsd: 27800,
    tokenSymbol: 'USDC→SUI',
    accentColor: '#FF6B35',
  },
  {
    id: 't-007',
    vaultId: SAMPLE_VAULT.id,
    kind: 'agent_funded',
    description: 'Initial deposit · 800,000 USDC from owner multisig',
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 27,
    txDigest: '2b8S7eJ9JU3vW6pH5gTrF9jY0nL2qK1oA7sU6mZ5rP3w',
    amount: 800000,
    amountUsd: 800000,
    tokenSymbol: 'USDC',
    accentColor: '#5BD49C',
  },
  {
    id: 't-008',
    vaultId: SAMPLE_VAULT.id,
    kind: 'agent_minted',
    description: 'Vault minted · session 0xbeef…90ab · 90-epoch expiry · 5 % epoch cap',
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 27 - 30000,
    txDigest: '1a7R6dI8IT2uV5oG4fSqE8iX9mK1pJ0nZ6rT5lY4qO2v',
    accentColor: '#030F1C',
  },
];

export const SAMPLE_REBALANCE_HISTORY = [
  1_124_310, 1_135_870, 1_141_200, 1_152_488, 1_148_900, 1_163_412, 1_175_800, 1_182_044,
  1_177_900, 1_190_800, 1_205_310, 1_212_488, 1_220_900, 1_229_900, 1_238_220, 1_244_310,
  1_247_582,
];
