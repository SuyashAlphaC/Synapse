import { NextResponse } from 'next/server';
import { updateHostedRuntimeCoordination } from '@/lib/hosted-runtime/provisioner';
import type { UpdateHostedRuntimeCoordinationRequest } from '@/lib/hosted-runtime/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as UpdateHostedRuntimeCoordinationRequest;
    if (!body.vaultId || typeof body.vaultId !== 'string') {
      return NextResponse.json({ error: 'vaultId required' }, { status: 400 });
    }
    if (typeof body.crossAgentPeerVaultIds !== 'string') {
      return NextResponse.json({ error: 'crossAgentPeerVaultIds required (string)' }, { status: 400 });
    }
    const result = await updateHostedRuntimeCoordination(body);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('disabled') ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
