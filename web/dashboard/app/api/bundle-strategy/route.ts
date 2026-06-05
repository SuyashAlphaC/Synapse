import { NextResponse } from 'next/server';
import {
  bundleStrategyForWalrus,
  detectBundleMode,
  type StrategyBundleMode,
} from '@/lib/strategy-bundle-server';

export const runtime = 'nodejs';

interface Body {
  source: string;
  filename?: string;
  mode?: StrategyBundleMode;
}

/**
 * Server-side strategy bundler — required for LangGraph strategies because
 * the browser esbuild-wasm bundler cannot resolve `@langchain/*` from node_modules.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.source || typeof body.source !== 'string') {
      return NextResponse.json({ error: 'source (string) required' }, { status: 400 });
    }
    if (body.source.length > 512 * 1024) {
      return NextResponse.json({ error: 'source exceeds 512 KiB' }, { status: 400 });
    }
    const filename = body.filename ?? 'strategy.ts';
    const mode = body.mode ?? detectBundleMode(body.source);
    const result = await bundleStrategyForWalrus({ source: body.source, filename, mode });
    return NextResponse.json({
      mode: result.mode,
      sha256Hex: result.sha256Hex,
      sizeBytes: result.bytes.byteLength,
      text: result.text,
      /** Base64 bundle bytes for client-side Walrus upload. */
      bundleBase64: Buffer.from(result.bytes).toString('base64'),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
