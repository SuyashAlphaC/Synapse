import { NextResponse } from 'next/server';
import { getLiveBacktest } from '@/lib/backtest-service.server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ strategyId: string }> },
) {
  const { strategyId } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(strategyId)) {
    return NextResponse.json({ error: 'Invalid strategy id' }, { status: 400 });
  }
  try {
    const summary = await getLiveBacktest(strategyId);
    if (!summary) {
      return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });
    }
    return NextResponse.json(summary, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
