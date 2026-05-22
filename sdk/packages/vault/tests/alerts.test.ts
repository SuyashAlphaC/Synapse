/**
 * Webhook alert tests. No real HTTP — `fetchImpl` is injected so we
 * exercise the contract (POST + JSON body + 2xx handling + no-throw
 * on failure) without network.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendAlert } from '../src/runtime/alerts.js';

describe('sendAlert', () => {
  it('skips silently when no webhook URL is configured', async () => {
    const fetchImpl = vi.fn();
    const ok = await sendAlert(
      { event: 'runtime_started', agentId: '0xabc' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs JSON to the URL and reports 2xx as success', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const ok = await sendAlert(
      { event: 'runtime_started', agentId: '0xabcdef0123456789', detail: 'hello' },
      { url: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/hook');
    const initObj = init as RequestInit;
    expect(initObj.method).toBe('POST');
    const body = JSON.parse(initObj.body as string);
    // Discord uses `content`, Slack uses `text` — we include both.
    expect(body.content).toMatch(/Synapse runtime started/);
    expect(body.text).toMatch(/Synapse runtime started/);
    expect(body.event).toBe('runtime_started');
    expect(body.agentId).toBe('0xabcdef0123456789');
  });

  it('returns false (not throws) on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const ok = await sendAlert(
      { event: 'runtime_failed' },
      { url: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ok).toBe(false);
  });

  it('returns false (not throws) on network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const ok = await sendAlert(
      { event: 'runtime_failed' },
      { url: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(ok).toBe(false);
  });
});
