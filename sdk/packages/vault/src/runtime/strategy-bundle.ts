/**
 * Node-side strategy bundler for Walrus publish + enclave attestation.
 *
 * Two modes:
 *   - `legacy` — self-contained strategist source; runtime imports are external
 *     (type-only `@synapse-core/vault` imports compile away).
 *   - `langgraph` — bundles LangGraph + Synapse deps into one ESM blob
 *     suitable for attested enclave execution (hash-verified, no missing imports).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export type StrategyBundleMode = 'legacy' | 'langgraph';

export interface BundleStrategyResult {
  bytes: Uint8Array;
  text: string;
  sha256Hex: string;
  mode: StrategyBundleMode;
}

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export interface BundleStrategyArgs {
  /** In-memory source (dashboard paste). */
  source: string;
  filename: string;
  mode?: StrategyBundleMode;
  /**
   * Absolute path to an on-disk entry file (CLI / monorepo). When set, esbuild
   * resolves workspace imports from the repo root — required for bundled
   * reference strategies like `mean-reversion-langgraph.ts`.
   */
  entryPath?: string;
}

export async function bundleStrategyForWalrus(
  args: BundleStrategyArgs,
): Promise<BundleStrategyResult> {
  const mode =
    args.mode ??
    (args.entryPath ? 'langgraph' : detectBundleMode(args.source));
  const esbuild = await import('esbuild');

  if (args.entryPath && mode === 'langgraph') {
    const entryPath = resolve(args.entryPath);
    const absWorkingDir = bundleWorkingDirFromModule(import.meta.url);
    const result = await esbuild.build({
      entryPoints: [entryPath],
      absWorkingDir,
      bundle: true,
      format: 'esm',
      target: 'node20',
      platform: 'node',
      legalComments: 'none',
      treeShaking: true,
      minify: false,
      write: false,
      logLevel: 'silent',
      packages: 'bundle',
    });
    return finalizeBuild(result, mode);
  }

  const absWorkingDir =
    mode === 'langgraph' ? bundleWorkingDirFromModule(import.meta.url) : undefined;

  const tmpDir = absWorkingDir
    ? mkdtempSync(join(absWorkingDir, '.synapse-strategy-'))
    : mkdtempSync(join(tmpdir(), 'synapse-strategy-'));
  const entryPath = join(tmpDir, args.filename.replace(/[^\w.-]/g, '_') || 'entry.ts');
  writeFileSync(entryPath, args.source, 'utf8');

  try {
    const result = await esbuild.build({
      entryPoints: [entryPath],
      ...(absWorkingDir ? { absWorkingDir } : {}),
      bundle: true,
      format: 'esm',
      target: mode === 'langgraph' ? 'node20' : 'es2022',
      platform: mode === 'langgraph' ? 'node' : 'neutral',
      legalComments: 'none',
      treeShaking: true,
      minify: mode === 'langgraph',
      write: false,
      logLevel: 'silent',
      ...(mode === 'legacy'
        ? { plugins: [legacyExternalPlugin(entryPath)] }
        : { packages: 'bundle' as const }),
    });
    return finalizeBuild(result, mode);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function finalizeBuild(
  result: import('esbuild').BuildResult,
  mode: StrategyBundleMode,
): BundleStrategyResult {
  const out = result.outputFiles?.[0];
  if (!out) {
    throw new Error('esbuild produced no output');
  }
  const bytes = out.contents;
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Bundle is ${bytes.byteLength} bytes — exceeds ${MAX_BUNDLE_BYTES} byte limit`,
    );
  }
  validateBundleShape(out.text);
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  return { bytes, text: out.text, sha256Hex, mode };
}

/** Auto-select langgraph mode when the source imports LangGraph packages. */
export function detectBundleMode(source: string): StrategyBundleMode {
  if (
    /@langchain\/langgraph/.test(source) ||
    /@anthropic-ai\/sdk/.test(source) ||
    /createLangGraphStrategy/.test(source) ||
    /meanReversionLangGraph/.test(source) ||
    /synapseLangGraph/.test(source)
  ) {
    return 'langgraph';
  }
  return 'legacy';
}

function hasDefaultExport(text: string): boolean {
  return (
    /\bexport\s+default\b/.test(text) ||
    /\bexport\s*\{[^}]*\bas\s+default\b/.test(text) ||
    /\bexport\s*\{[^}]*\bdefault\s+as\b/.test(text)
  );
}

function legacyExternalPlugin(entryPath: string): import('esbuild').Plugin {
  return {
    name: 'synapse-legacy-external',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (resolved) => {
        if (resolved.path === entryPath) return { path: entryPath };
        return { external: true, path: resolved.path };
      });
    },
  };
}

function validateBundleShape(text: string): void {
  if (!hasDefaultExport(text)) {
    throw new Error('Bundle has no default export');
  }
  if (!/evaluate/.test(text)) {
    throw new Error('Bundle does not reference `evaluate`');
  }
}

/**
 * Directory esbuild uses to resolve `node_modules` when bundling LangGraph /
 * LLM strategist sources. Prefer `@synapse-core/vault`'s package root (where
 * `@langchain/langgraph` and `@anthropic-ai/sdk` are declared) so dashboard
 * `/api/bundle-strategy` can bundle pasted sources written to `/tmp`.
 */
export function bundleWorkingDirFromModule(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let depth = 0; depth < 8; depth++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@synapse-core/vault') {
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const here = dirname(fileURLToPath(metaUrl));
  if (here.includes('sdk/packages/vault/dist')) {
    return resolve(here, '..');
  }
  if (here.includes('sdk/packages/vault/src')) {
    return resolve(here, '..');
  }
  if (here.includes('examples/publish')) {
    return resolve(here, '../../sdk/packages/vault');
  }
  return resolve(here, '../../../..');
}

/** Monorepo root (Synapse/) — legacy alias for disk-entry bundles. */
export function repoRootFromModule(metaUrl: string): string {
  return bundleWorkingDirFromModule(metaUrl);
}
