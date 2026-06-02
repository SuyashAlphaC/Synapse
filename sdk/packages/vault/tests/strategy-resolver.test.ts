import { describe, it, expect } from 'vitest';
import { buildStrategy } from '../src/runtime/strategy-resolver.js';
import { LLM_ADVISOR_ID } from '../src/strategies/llm-advisor.js';

describe('buildStrategy apiKey threading', () => {
  it('builds the llm-advisor with an apiKey override', () => {
    const s = buildStrategy(LLM_ADVISOR_ID, { apiKey: 'sk-ant-xyz' });
    expect(s.id).toBe(LLM_ADVISOR_ID);
  });

  it('builds the llm-advisor without an apiKey (env fallback)', () => {
    const s = buildStrategy(LLM_ADVISOR_ID, {});
    expect(s.id).toBe(LLM_ADVISOR_ID);
  });
});
