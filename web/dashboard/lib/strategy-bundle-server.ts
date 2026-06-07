/**
 * Server-side Walrus strategy bundler for `/api/bundle-strategy`.
 *
 * Lives in the dashboard (not `@synapse-core/vault`) so Next.js can static-
 * import it without "expression is too dynamic" errors from Turbopack.
 *
 * LangGraph / LLM strategies resolve deps from `@synapse-core/vault`'s package
 * root (monorepo checkout or `node_modules` copy).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type StrategyBundleMode = 'legacy' | 'langgraph';

export interface BundleStrategyResult {
  bytes: Uint8Array;
  text: string;
  sha256Hex: string;
  mode: StrategyBundleMode;
}

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export interface BundleStrategyArgs {
  source: string;
  filename: string;
  mode?: StrategyBundleMode;
}

export async function bundleStrategyForWalrus(
  args: BundleStrategyArgs,
): Promise<BundleStrategyResult> {
  const mode = args.mode ?? detectBundleMode(args.source);
  const esbuild = await import('esbuild');

  const absWorkingDir = mode === 'langgraph' ? langGraphWorkingDir() : undefined;

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

/** Resolve `@synapse-core/vault` for LangGraph dependency bundling. */
export function langGraphWorkingDir(): string {
  const candidates = [join(process.cwd(), 'node_modules/@synapse-core/vault')];
  for (const dir of candidates) {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === '@synapse-core/vault') return dir;
    } catch {
      // try next
    }
  }
  throw new Error(
    'LangGraph bundling could not find @synapse-core/vault. From web/dashboard run: npm run sync-vault',
  );
}

function finalizeBuild(
  result: import('esbuild').BuildResult,
  mode: StrategyBundleMode,
): BundleStrategyResult {
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output');
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
