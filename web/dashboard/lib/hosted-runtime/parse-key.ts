export interface ParsedSessionKeyFile {
  sessionAddress: string;
  secretBase64: string;
  memwalDelegateHex: string | null;
}

export function parseSessionKeyFileJson(raw: string): ParsedSessionKeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('sessionKeyFileJson is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('sessionKeyFileJson must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const secretBase64 = obj.secretBase64;
  if (typeof secretBase64 !== 'string' || secretBase64.length === 0) {
    throw new Error('.key file missing secretBase64');
  }
  const sessionAddress = obj.address;
  if (typeof sessionAddress !== 'string' || !sessionAddress.startsWith('0x')) {
    throw new Error('.key file missing valid address');
  }

  let memwalDelegateHex: string | null = null;
  const delegate = obj.memwalDelegate;
  if (delegate !== null && delegate !== undefined) {
    if (typeof delegate !== 'object') {
      throw new Error('memwalDelegate must be an object when present');
    }
    const hex = (delegate as { privateKeyHex?: unknown }).privateKeyHex;
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('memwalDelegate.privateKeyHex must be 64 hex chars');
    }
    memwalDelegateHex = hex.toLowerCase();
  }

  return { sessionAddress, secretBase64, memwalDelegateHex };
}

export function assertVaultId(vaultId: string): void {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(vaultId)) {
    throw new Error('vaultId must be a 0x-prefixed hex AgentIdentity id');
  }
}
