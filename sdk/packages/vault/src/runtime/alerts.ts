/**
 * Webhook alerter for runtime liveness + failure events.
 *
 * When `SYNAPSE_ALERT_WEBHOOK_URL` is set, the runtime POSTs a small
 * JSON payload on:
 *   - startup (`runtime_started`)
 *   - top-level crash (`runtime_failed`)
 *   - max consecutive tick failures reached (`runtime_max_failures`)
 *
 * The payload shape works as-is for Discord (`{ content }`) and
 * generic JSON sinks. Slack incoming-webhook URLs accept `{ text }`,
 * which we also include. Anything more exotic (PagerDuty etc.) can
 * sit behind a tiny edge function — keeping this dependency-free.
 *
 * Failure of the webhook itself never throws — the runtime keeps
 * running. The whole point is "best-effort heads-up", not a tx
 * critical path.
 */

import type { VaultLogger } from './logger.js';

export type AlertEvent =
  | 'runtime_started'
  | 'runtime_failed'
  | 'runtime_max_failures'
  | 'tick_failed';

export interface AlertPayload {
  event: AlertEvent;
  /** Vault id when known. */
  agentId?: string;
  /** Free-text detail line (kept short — most webhooks truncate). */
  detail?: string;
  /** Optional structured context (counts, error class, etc.). */
  context?: Record<string, unknown>;
}

const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Best-effort POST to the configured webhook. Returns `true` on 2xx,
 * `false` on any non-2xx or network failure. Never throws.
 */
export async function sendAlert(
  payload: AlertPayload,
  opts: { url?: string; logger?: VaultLogger; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const url = opts.url ?? process.env.SYNAPSE_ALERT_WEBHOOK_URL;
  if (!url) return false;

  const tagline = renderTagline(payload);
  const body = JSON.stringify({
    // Discord
    content: tagline,
    // Slack
    text: tagline,
    // Generic / our own consumers
    ...payload,
    ts: new Date().toISOString(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      opts.logger?.warn(
        { status: res.status, event: payload.event },
        'alert webhook returned non-2xx',
      );
      return false;
    }
    return true;
  } catch (err) {
    opts.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), event: payload.event },
      'alert webhook failed',
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function renderTagline(p: AlertPayload): string {
  const head =
    p.event === 'runtime_started'
      ? 'Synapse runtime started'
      : p.event === 'runtime_failed'
        ? 'Synapse runtime crashed'
        : p.event === 'runtime_max_failures'
          ? 'Synapse runtime hit max consecutive failures'
          : 'Synapse tick failed';
  const vault = p.agentId ? ` for vault ${shortAgent(p.agentId)}` : '';
  const detail = p.detail ? ` — ${p.detail}` : '';
  return `${head}${vault}${detail}`;
}

function shortAgent(agentId: string): string {
  return agentId.length > 14 ? `${agentId.slice(0, 8)}…${agentId.slice(-4)}` : agentId;
}
