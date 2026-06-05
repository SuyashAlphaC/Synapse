import { NextResponse } from 'next/server';
import { enableHostedRuntime } from '@/lib/hosted-runtime/provisioner';
import type { EnableHostedRuntimeRequest } from '@/lib/hosted-runtime/types';

export const runtime = 'nodejs';
/** Secrets upsert + CFN create/update can exceed default 10s on Vercel Hobby. */
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as EnableHostedRuntimeRequest;
    if (!body.vaultId || typeof body.vaultId !== 'string') {
      return NextResponse.json({ error: 'vaultId required' }, { status: 400 });
    }
    const result = await enableHostedRuntime(body);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('disabled') ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
