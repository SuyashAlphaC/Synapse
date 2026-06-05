import { NextResponse } from 'next/server';
import { setHostedRuntimePaused } from '@/lib/hosted-runtime/provisioner';

export const runtime = 'nodejs';

interface Body {
  vaultId: string;
  /** When true, disables the EventBridge tick schedule. When false, re-enables it. */
  paused: boolean;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    if (!body.vaultId || typeof body.vaultId !== 'string') {
      return NextResponse.json({ error: 'vaultId required' }, { status: 400 });
    }
    if (typeof body.paused !== 'boolean') {
      return NextResponse.json({ error: 'paused (boolean) required' }, { status: 400 });
    }
    await setHostedRuntimePaused(body.vaultId, body.paused);
    return NextResponse.json({ ok: true, paused: body.paused });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('disabled') ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
