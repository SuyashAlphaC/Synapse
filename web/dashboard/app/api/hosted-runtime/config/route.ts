import { NextResponse } from 'next/server';
import { getHostedRuntimePublicConfig } from '@/lib/hosted-runtime/public-config';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getHostedRuntimePublicConfig());
}
