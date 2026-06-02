// The advisor reasoning, running INSIDE the enclave. Mirrors the off-chain
// `llm-advisor` strategy but calls Claude over raw fetch (no SDK) so the enclave
// image stays minimal and reproducible. The Anthropic key lives in the enclave
// (mounted secret / env) and never touches the host — this is the key-custody
// upgrade the attestation buys us.

const DEFAULT_MODEL = 'claude-opus-4-8';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const RECOMMENDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targetBaseWeight: { type: 'number', description: 'Target base-asset weight, 0 to 1.' },
    confidence: { type: 'number', description: 'Confidence in this call, 0 to 1.' },
    rationale: { type: 'string', description: 'One or two sentences of reasoning.' },
  },
  required: ['targetBaseWeight', 'confidence', 'rationale'],
};

/**
 * Ask Claude for a target weight given the market + recalled memory the host
 * supplied. Returns `{ targetBaseWeight, confidence, rationale }` or null when no
 * key is configured / the model can't be parsed.
 */
export async function advise(input, { apiKey, model } = {}) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model ?? DEFAULT_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA } },
      system:
        'You are a conservative on-chain treasury manager. You allocate between a base and a quote ' +
        'asset to preserve capital while capturing modest drift. You are given live market data and ' +
        'your own past decisions recalled from persistent memory. Choose a target base-asset weight. ' +
        'Prefer small, well-reasoned adjustments; do not chase volatility.',
      messages: [{ role: 'user', content: buildPrompt(input) }],
    }),
  });

  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  const text = body.content?.find((b) => b.type === 'text')?.text;
  if (!text) return null;
  const parsed = JSON.parse(text);
  if (
    typeof parsed.targetBaseWeight !== 'number' ||
    typeof parsed.confidence !== 'number' ||
    typeof parsed.rationale !== 'string'
  ) {
    return null;
  }
  return parsed;
}

function buildPrompt(input) {
  const facts = (input.memoryFacts ?? []).slice(-8).map((f) => `- ${f}`).join('\n') || '- (none)';
  return [
    `Epoch: ${input.epoch}`,
    `NAV: $${(input.navUsd ?? 0).toFixed(2)}`,
    `Current ${input.baseSymbol} weight: ${((input.baseWeight ?? 0) * 100).toFixed(2)}%`,
    `Prices: ${input.baseSymbol}=$${(input.basePriceUsd ?? 0).toFixed(4)}, ${input.quoteSymbol}=$${(input.quotePriceUsd ?? 1).toFixed(4)}`,
    ``,
    `Recalled memory (most recent last):`,
    facts,
    ``,
    `Choose the target ${input.baseSymbol} weight (0-1), your confidence (0-1), and a one or two ` +
      `sentence rationale. Be conservative; small adjustments compound.`,
  ].join('\n');
}
