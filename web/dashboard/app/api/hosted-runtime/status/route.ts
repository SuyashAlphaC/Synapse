import { NextResponse } from 'next/server';
import { getHostedRuntimeStatus } from '@/lib/hosted-runtime/provisioner';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const vaultId = url.searchParams.get('vaultId');
    if (!vaultId) {
      return NextResponse.json({ error: 'vaultId query param required' }, { status: 400 });
    }
    const status = await getHostedRuntimeStatus(vaultId);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
