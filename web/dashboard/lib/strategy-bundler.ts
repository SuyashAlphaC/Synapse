/**
 * Browser-side strategy bundler.
 *
 * Uses esbuild-wasm to compile a strategist's TypeScript (or JavaScript)
 * source into a single self-contained ESM bundle that can be persisted to
 * Walrus and later loaded by a vault runtime. All imports are stripped
 * (treated as `external` — strategists must write self-contained code);
 * type-only imports get erased by TypeScript's transform anyway.
 *
 * esbuild-wasm initialization is global and must happen exactly once.
 * We lazy-load it on first bundle so the dashboard's initial paint isn't
 * blocked by the ~10MB WASM download.
 */
import type { BuildResult, Loader, Plugin } from 'esbuild-wasm';

/**
 * Pinned esbuild-wasm version. Bump together with the npm dep.
 * The WASM binary is fetched from unpkg so we don't have to wire
 * Next.js's asset pipeline to serve it.
 */
const ESBUILD_VERSION = '0.24.2';
const ESBUILD_WASM_URL = `https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

export interface BundleResult {
  /** The compiled ESM bundle as bytes — what gets uploaded to Walrus. */
  bytes: Uint8Array;
  /** Human-readable JS for the strategist to inspect. */
  text: string;
  /** Warnings reported by esbuild (e.g. shadowed identifiers). */
  warnings: string[];
}

export interface BundleError {
  /** Pretty multi-line error message ready to drop into a UI panel. */
  message: string;
  /** Line/col for the first error, when available. */
  location: { file: string; line: number; column: number } | null;
}

export class StrategyBundleError extends Error {
  readonly location: BundleError['location'];
  constructor(detail: BundleError) {
    super(detail.message);
    this.name = 'StrategyBundleError';
    this.location = detail.location;
  }
}

/**
 * Bundle a single strategist source file into a self-contained ESM module.
 *
 * The contract for `source`:
 *  - Must have an `export default` (either the Strategy object itself, or
 *    a factory function returning a Strategy).
 *  - Any non-type imports are treated as external and will fail at runtime
 *    when the bundle is loaded — we surface this as a warning.
 *  - Type-only imports (e.g. `import type { Strategy } …`) are erased.
 */
export async function bundleStrategySource(args: {
  source: string;
  filename: string;
}): Promise<BundleResult> {
  const esbuild = await getEsbuild();
  const loader = resolveLoader(args.filename);

  // Virtual entry plugin so esbuild can resolve our in-memory source under
  // a synthetic path, while treating every other import as external.
  const ENTRY = `synapse:entry`;
  const virtualEntry: Plugin = {
    name: 'synapse-virtual-entry',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (resolved) => {
        if (resolved.path === ENTRY) return { path: ENTRY, namespace: 'synapse' };
        // Anything else: mark external so the bundle stays self-contained.
        // The strategist is responsible for not importing runtime deps.
        return { external: true, path: resolved.path };
      });
      build.onLoad({ filter: /.*/, namespace: 'synapse' }, () => ({
        contents: args.source,
        loader,
      }));
    },
  };

  let result: BuildResult;
  try {
    result = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'neutral',
      legalComments: 'none',
      treeShaking: true,
      minify: false,
      write: false,
      plugins: [virtualEntry],
      logLevel: 'silent',
    });
  } catch (err) {
    throw asBundleError(err, args.filename);
  }

  const out = result.outputFiles?.[0];
  if (!out) {
    throw new StrategyBundleError({
      message: 'esbuild produced no output (empty input?)',
      location: null,
    });
  }
  const text = out.text;
  validateBundleShape(text);
  return {
    bytes: out.contents,
    text,
    warnings: result.warnings.map((w) =>
      w.location
        ? `${w.location.file}:${w.location.line}:${w.location.column}  ${w.text}`
        : w.text,
    ),
  };
}

/**
 * Light sanity check on the bundle. Catches the obvious "user forgot
 * the export" case before we charge them an on-chain publish. We do NOT
 * execute the bundle — that's the runtime's job, in its own sandbox.
 */
function validateBundleShape(text: string): void {
  if (!/export\s+(default|{[^}]*default[^}]*})/.test(text)) {
    throw new StrategyBundleError({
      message:
        'Bundle has no `export default`. ' +
        'A strategy file must default-export either a Strategy object or a factory returning one.',
      location: null,
    });
  }
  if (!/evaluate/.test(text)) {
    throw new StrategyBundleError({
      message:
        'Bundle does not reference an `evaluate` member. ' +
        'A Strategy must define `async evaluate(input): Promise<StrategyDecision>`.',
      location: null,
    });
  }
}

function resolveLoader(filename: string): Loader {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'ts';
  if (filename.endsWith('.js') || filename.endsWith('.mjs') || filename.endsWith('.jsx'))
    return 'js';
  // Default to TS — it's a strict superset of JS, so plain-JS sources
  // still compile cleanly through the TS loader.
  return 'ts';
}

function asBundleError(err: unknown, filename: string): StrategyBundleError {
  if (err !== null && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors?: Array<{ text: string; location?: { line?: number; column?: number } | null }> }).errors ?? [];
    if (errors.length > 0) {
      const first = errors[0]!;
      const message = errors
        .map((e) => {
          const loc = e.location ? `${filename}:${e.location.line ?? 0}:${e.location.column ?? 0}` : filename;
          return `${loc}\n    ${e.text}`;
        })
        .join('\n\n');
      const loc = first.location
        ? { file: filename, line: first.location.line ?? 0, column: first.location.column ?? 0 }
        : null;
      return new StrategyBundleError({ message, location: loc });
    }
  }
  return new StrategyBundleError({
    message: err instanceof Error ? err.message : String(err),
    location: null,
  });
}

// ---------------------------------------------------------------------------
// esbuild-wasm lazy init
// ---------------------------------------------------------------------------

type EsbuildModule = typeof import('esbuild-wasm');

let esbuildPromise: Promise<EsbuildModule> | null = null;

async function getEsbuild(): Promise<EsbuildModule> {
  if (!esbuildPromise) {
    esbuildPromise = (async () => {
      const mod = (await import('esbuild-wasm')) as EsbuildModule;
      await mod.initialize({ wasmURL: ESBUILD_WASM_URL });
      return mod;
    })().catch((err) => {
      // Reset so retries work after a transient network failure.
      esbuildPromise = null;
      throw err;
    });
  }
  return esbuildPromise;
}
