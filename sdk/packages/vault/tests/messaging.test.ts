import { describe, it, expect } from 'vitest';
import { consumeSignals, emitSignal, type MessagingLike } from '../src/runtime/messaging.js';

function consumeClient(messages: { text: string; sender: string }[]): MessagingLike {
  return {
    messaging: {
      getChannelMessages: async () => ({
        messages: messages.map((m) => ({ text: m.text, sender: m.sender, createdAtMs: '0' })),
        cursor: BigInt(messages.length),
        hasNextPage: false,
      }),
      getUserMemberCap: async () => ({ id: { id: '0xcap' } }),
      getChannelObjectsByChannelIds: async () => [],
      executeSendMessageTransaction: async () => ({ digest: '0xd' }),
    },
  };
}

describe('consumeSignals', () => {
  it('returns peer messages as fact strings and advances the cursor', async () => {
    const res = await consumeSignals({
      client: consumeClient([{ text: 'rotate 5% SUI->USDC', sender: '0xpeerabcdef' }]),
      inboxChannelId: '0xchan',
      userAddress: '0xme',
      lastCursor: null,
    });
    expect(res.facts).toHaveLength(1);
    expect(res.facts[0]).toContain('rotate 5% SUI->USDC');
    expect(res.facts[0]).toContain('0xpeerabc');
    expect(res.newCursor).toBe(1n);
  });

  it('no-ops cleanly when inboxChannelId is null', async () => {
    const res = await consumeSignals({
      client: consumeClient([]),
      inboxChannelId: null,
      userAddress: '0xme',
      lastCursor: null,
    });
    expect(res.facts).toEqual([]);
    expect(res.newCursor).toBeNull();
  });

  it('degrades to empty facts (keeps cursor) when the client throws', async () => {
    const throwing: MessagingLike = {
      messaging: {
        getChannelMessages: async () => {
          throw new Error('relayer down');
        },
        getUserMemberCap: async () => null,
        getChannelObjectsByChannelIds: async () => [],
        executeSendMessageTransaction: async () => ({ digest: '0xd' }),
      },
    };
    const res = await consumeSignals({
      client: throwing,
      inboxChannelId: '0xchan',
      userAddress: '0xme',
      lastCursor: 7n,
    });
    expect(res.facts).toEqual([]);
    expect(res.newCursor).toBe(7n);
  });
});

function emitClient(sent: { message: string }[]): MessagingLike {
  return {
    messaging: {
      getChannelMessages: async () => ({ messages: [], cursor: null, hasNextPage: false }),
      getUserMemberCap: async () => ({ id: { id: '0xcap' } }),
      getChannelObjectsByChannelIds: async () => [
        { encryption_key_history: { latest: [1, 2, 3], latest_version: 0 } },
      ],
      executeSendMessageTransaction: async (req) => {
        sent.push({ message: req.message });
        return { digest: '0xsenddigest' };
      },
    },
  };
}

describe('emitSignal', () => {
  it('sends one message and returns the digest', async () => {
    const sent: { message: string }[] = [];
    const res = await emitSignal({
      client: emitClient(sent),
      outboxChannelId: '0xout',
      userAddress: '0xme',
      signer: {},
      message: 'rebalanced 5% SUI->USDC',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain('rebalanced');
    expect(res?.digest).toBe('0xsenddigest');
  });

  it('no-ops (returns null) when outboxChannelId is null', async () => {
    const sent: { message: string }[] = [];
    const res = await emitSignal({
      client: emitClient(sent),
      outboxChannelId: null,
      userAddress: '0xme',
      signer: {},
      message: 'x',
    });
    expect(res).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('degrades to null when the member cap is missing', async () => {
    const client: MessagingLike = {
      messaging: {
        getChannelMessages: async () => ({ messages: [], cursor: null, hasNextPage: false }),
        getUserMemberCap: async () => null,
        getChannelObjectsByChannelIds: async () => [
          { encryption_key_history: { latest: [1], latest_version: 0 } },
        ],
        executeSendMessageTransaction: async () => ({ digest: '0xd' }),
      },
    };
    const res = await emitSignal({
      client,
      outboxChannelId: '0xout',
      userAddress: '0xme',
      signer: {},
      message: 'x',
    });
    expect(res).toBeNull();
  });
});

import { messageDigest, recordSendPTB } from '../src/runtime/messaging.js';
import { Transaction } from '@mysten/sui/transactions';

describe('audit records', () => {
  it('messageDigest returns a 32-byte array', async () => {
    const d = await messageDigest('hello');
    expect(d).toHaveLength(32);
    expect(d.every((b) => b >= 0 && b <= 255)).toBe(true);
  });

  it('recordSendPTB adds a moveCall to the transaction', () => {
    const tx = new Transaction();
    const id = (n: string) => `0x${n.padStart(64, '0')}`;
    recordSendPTB(tx, id('a'), id('b'), id('c'), [1, 2, 3]);
    expect(tx.getData().commands.length).toBeGreaterThan(0);
  });
});
