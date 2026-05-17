/**
 * Config parser tests — focused on the SYNAPSE_PACKAGE_HISTORY env
 * shape. Tests run against the pure parser, no Sui client involved.
 */

import { describe, expect, it } from 'vitest';
import { loadFromEnv } from '../src/runtime/config.js';

const V3 = '0xd849b7b281cdc030daf4e2269a36e85e285edd44849b481eb6da49aed1978f01';
const V2 = '0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed';
const V1 = '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

function baseEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    SYNAPSE_PACKAGE_ID: V3,
    SYNAPSE_AGENT_ID: '0xa758924d6ac5db6680ae7a32011f759af3d991fbc58e0c5c8637680ff824138f',
    SYNAPSE_SESSION_KEY: 'suiprivkey1qtest',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadFromEnv → packageHistory', () => {
  it('defaults to [packageId] when SYNAPSE_PACKAGE_HISTORY is unset', () => {
    const config = loadFromEnv(baseEnv({}));
    expect(config.packageHistory).toEqual([V3]);
    expect(config.packageHistory[0]).toBe(config.packageId);
  });

  it('parses a comma-separated list and forces packageId to the head', () => {
    const config = loadFromEnv(
      baseEnv({ SYNAPSE_PACKAGE_HISTORY: `${V3},${V2},${V1}` }),
    );
    expect(config.packageHistory).toEqual([V3, V2, V1]);
  });

  it('dedupes entries (history may explicitly include packageId)', () => {
    const config = loadFromEnv(
      baseEnv({ SYNAPSE_PACKAGE_HISTORY: `${V3},${V2},${V3},${V1}` }),
    );
    expect(config.packageHistory).toEqual([V3, V2, V1]);
  });

  it('handles whitespace + empty entries gracefully', () => {
    const config = loadFromEnv(
      baseEnv({ SYNAPSE_PACKAGE_HISTORY: ` ${V2}  ,, ${V1} ,` }),
    );
    expect(config.packageHistory).toEqual([V3, V2, V1]);
  });

  it('promotes packageId to the head even if the user listed it last', () => {
    const config = loadFromEnv(
      baseEnv({ SYNAPSE_PACKAGE_HISTORY: `${V1},${V2},${V3}` }),
    );
    expect(config.packageHistory[0]).toBe(V3);
    // The remaining versions retain their declared order.
    expect(config.packageHistory).toEqual([V3, V1, V2]);
  });

  it('throws on a non-hex entry — never silently accepts garbage', () => {
    expect(() =>
      loadFromEnv(baseEnv({ SYNAPSE_PACKAGE_HISTORY: `${V3},not-a-hex-id` })),
    ).toThrow(/not a 0x-prefixed hex package ID/);
  });
});
