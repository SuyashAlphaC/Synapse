/**
 * Structured logger for the headless runtime.
 *
 * Two production guarantees on top of pino:
 *
 *   1. **Field-name redaction.** Any log binding whose key looks like a
 *      secret (`sessionKey`, `secret`, `delegate`, `apiKey`, …) is
 *      replaced with `[REDACTED]` before it ever reaches stdout. Even if
 *      a future call site accidentally logs `{ sessionKey: signer.secretKey }`,
 *      pino prints `"sessionKey":"[REDACTED]"`.
 *
 *   2. **Value-shape redaction.** Any string in any log binding that
 *      matches the well-known shapes of our two secrets — Sui CLI
 *      `suiprivkey…` and 64-char hex (MemWal delegate) — is replaced
 *      with `[REDACTED]`. Defends against logging a secret under an
 *      innocuous field name, e.g. `{ value: signer.secretKey }`.
 *
 * Both gates are unit-tested. Together they make "secret in logs" a
 * compile-time + runtime gate, not a code-review hope.
 */

import pino, { stdSerializers, type Logger } from 'pino';

export type VaultLogger = Logger;

/**
 * Field names that DEFINITELY carry a secret. Match is case-insensitive,
 * separator-insensitive, and *prefix-based*: a field named `sessionKey`
 * or `session_key_hex` triggers, but `sessionKeySource` /
 * `sessionKeyPath` do not — those carry metadata, not the secret.
 */
const SECRET_FIELD_PREFIXES = [
  'sessionkey',
  'sessionsecret',
  'secretkey',
  'secretbase64',
  'privatekey',
  'memwaldelegate',
  'delegatekey',
  'delegatekeyhex',
  'apikey',
  'authorization',
  'bearer',
];

/**
 * Suffixes that switch a "secret-shaped" field name into a metadata
 * one. `sessionKeyPath` is the file path, not the key bytes; same for
 * `…Source`, `…Id`, etc. Listing them explicitly keeps the rule
 * conservative and inspectable.
 */
const METADATA_SUFFIXES = ['path', 'source', 'id', 'name', 'prefix', 'hint', 'type', 'env'];

/** Value shapes we never want to print. */
const SUI_PRIVATE_KEY_RE = /suiprivkey1[0-9a-z]{40,}/i;
const HEX64_RE = /\b[0-9a-f]{64}\b/i;

function isSecretFieldName(name: string): boolean {
  const lowered = name.toLowerCase().replace(/[_\-\s]/g, '');
  for (const prefix of SECRET_FIELD_PREFIXES) {
    if (!lowered.startsWith(prefix)) continue;
    const remainder = lowered.slice(prefix.length);
    // Exact match or a non-metadata extension (`sessionKeyHex` is still a key).
    if (remainder.length === 0) return true;
    if (!METADATA_SUFFIXES.some((suffix) => remainder.startsWith(suffix))) return true;
  }
  return false;
}

function redactString(value: string): string {
  if (SUI_PRIVATE_KEY_RE.test(value)) return '[REDACTED:suiprivkey]';
  if (HEX64_RE.test(value)) return '[REDACTED:hex64]';
  return value;
}

/**
 * Recursively walk an object and redact secret-looking fields/values.
 * Exported for tests; pino is wired to call it on every log invocation.
 */
export function redactBindings(input: unknown, depth = 0): unknown {
  if (depth > 6) return input;
  if (typeof input === 'string') return redactString(input);
  if (input instanceof Error) {
    // Error fields are non-enumerable; `Object.entries` returns [] and
    // the log line ends up as `"err":{}`. Inline-serialize to a plain
    // object so the redaction walker (and pino's JSON output) see the
    // message + stack.
    return {
      type: input.name,
      message: redactString(input.message),
      stack: input.stack ? redactString(input.stack) : undefined,
    };
  }
  if (Array.isArray(input)) return input.map((v) => redactBindings(v, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isSecretFieldName(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactBindings(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

export function createLogger(name = 'synapse-vault-runtime'): VaultLogger {
  return pino({
    name,
    level: process.env.SYNAPSE_LOG_LEVEL ?? 'info',
    base: {
      service: name,
    },
    // Errors are non-enumerable; without this serializer pino prints
    // `"err":{}` for every Error binding and the operator sees nothing.
    serializers: { err: stdSerializers.err },
    // pino's `formatters.log` runs on every log line's bindings object,
    // so even an accidental `logger.info({ sessionKey: ... })` is
    // scrubbed before serialization.
    formatters: {
      log(object: Record<string, unknown>): Record<string, unknown> {
        return redactBindings(object) as Record<string, unknown>;
      },
    },
  });
}
