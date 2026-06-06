import { describe, it, expect } from 'vitest';
import {
  buildStrategy,
  resolveStrategySlug,
  KNOWN_STRATEGIES,
} from '../src/runtime/strategy-resolver.js';
import { CONSERVATIVE_REBALANCER_ID } from '../src/strategies/conservative-rebalancer.js';
import { DCA_TWAP_ID } from '../src/strategies/dca-twap.js';

describe('built-in strategy resolution', () => {
  it('builds conservative rebalancer', () => {
    const s = buildStrategy(CONSERVATIVE_REBALANCER_ID, {});
    expect(s.id).toBe(CONSERVATIVE_REBALANCER_ID);
  });

  it('builds dca/twap', () => {
    const s = buildStrategy(DCA_TWAP_ID, {});
    expect(s.id).toBe(DCA_TWAP_ID);
  });

  it('maps seeded marketplace strategy ids to built-ins', () => {
    const slugs = Object.values(KNOWN_STRATEGIES);
    expect(slugs).toContain(CONSERVATIVE_REBALANCER_ID);
    expect(slugs).toContain(DCA_TWAP_ID);
  });

  it('a non-built-in strategy id is NOT a known slug (Walrus-only)', () => {
    const slug = resolveStrategySlug(
      '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679',
    );
    expect(slug).toBeNull();
  });
});
