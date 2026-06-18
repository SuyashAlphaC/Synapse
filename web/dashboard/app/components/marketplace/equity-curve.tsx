'use client';

import { useMemo } from 'react';
import type { BacktestSummary } from '@/lib/backtests';

/**
 * Inline SVG equity-curve chart that compares the strategy's NAV trajectory
 * to a buy-and-hold benchmark of the same starting basket. Pure SVG, no
 * chart library — keeps the dashboard bundle small and the visual style
 * consistent with the brutalist theme.
 */
export function EquityCurve({
  summary,
  height = 120,
  accent,
}: {
  summary: BacktestSummary;
  height?: number;
  accent: string;
}) {
  const stats = useMemo(() => {
    const series = summary.series;
    const quoteAtStart =
      series[0]!.quoteUnits ??
      (series[0] as { usdcUnits?: number }).usdcUnits ??
      0;
    const benchmark = series.map((p) => series[0]!.suiUnits * p.priceUsd + quoteAtStart);
    const navMin = Math.min(
      ...series.map((p) => p.navUsd),
      ...benchmark,
    );
    const navMax = Math.max(
      ...series.map((p) => p.navUsd),
      ...benchmark,
    );
    const range = Math.max(1, navMax - navMin);
    return { series, benchmark, navMin, navMax, range };
  }, [summary]);

  const width = 360;
  const padX = 4;
  const padY = 6;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  function pathFor(values: number[]): string {
    const step = innerW / Math.max(1, values.length - 1);
    return values
      .map((v, i) => {
        const x = padX + i * step;
        const y = padY + innerH - ((v - stats.navMin) / stats.range) * innerH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  const navPath = pathFor(stats.series.map((p) => p.navUsd));
  const benchPath = pathFor(stats.benchmark);
  const tradeMarkers = stats.series
    .map((p, i) => ({ p, i }))
    .filter((entry) => entry.p.decision === 'rebalance');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`${summary.strategyName} 90-day equity curve`}
    >
      {/* Subtle gridlines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={padX}
          x2={width - padX}
          y1={padY + innerH * f}
          y2={padY + innerH * f}
          stroke="currentColor"
          strokeOpacity="0.08"
          strokeDasharray="2 4"
        />
      ))}

      {/* Benchmark (dashed grey) */}
      <path
        d={benchPath}
        fill="none"
        stroke="var(--ink-mute)"
        strokeWidth="1.4"
        strokeDasharray="3 3"
        opacity="0.85"
      />
      {/* Strategy (accent solid) */}
      <path d={navPath} fill="none" stroke={accent} strokeWidth="2" />

      {/* Trade markers */}
      {tradeMarkers.map(({ p, i }) => {
        const x = padX + (innerW / Math.max(1, stats.series.length - 1)) * i;
        const y =
          padY + innerH - ((p.navUsd - stats.navMin) / stats.range) * innerH;
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r="2.5"
            fill={accent}
            stroke="var(--ink)"
            strokeWidth="1"
          />
        );
      })}
    </svg>
  );
}
