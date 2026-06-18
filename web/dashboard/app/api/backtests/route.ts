import { NextResponse } from 'next/server';
import { getLiveBacktestIndex } from '@/lib/backtest-service.server';

export const runtime = 'nodejs';
/** CoinGecko + per-strategy replay can take a few seconds on cold start. */
export const maxDuration = 60;

export async function GET() {
  try {
    const index = await getLiveBacktestIndex();
    return NextResponse.json(index, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
