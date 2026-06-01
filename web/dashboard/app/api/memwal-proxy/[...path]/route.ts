import type { NextRequest } from 'next/server';

/**
 * Same-origin reverse proxy to the MemWal relayer.
 *
 * WHY THIS EXISTS: the in-browser runtime calls the MemWal relayer for
 * memory recall/remember on every tick. The public relayer
 * (relayer.staging.memwal.ai) does NOT send `access-control-allow-origin`
 * for browser origins, so a direct `fetch` from the dashboard fails with
 * `TypeError: Failed to fetch` (CORS) — and because that fetch runs
 * before the on-chain write, the whole tick aborts. (Sui RPC, Pyth
 * Hermes, and the Walrus publisher all send `ACAO: *` and work in-browser;
 * only the relayer doesn't.)
 *
 * The browser runtime points the MemWal SDK's `serverUrl` at this route
 * (`/api/memwal-proxy`). The SDK's signed canonical message covers only
 * the request PATH (`/api/recall`, `/config`, …) and the body — never
 * the host (see `@mysten-incubation/memwal` `signedRequest`:
 * `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${accountId}`).
 * So forwarding the suffix path verbatim to the relayer preserves the
 * signature: the relayer recomputes it over the same path it receives.
 *
 * Browser→proxy is same-origin (no CORS); proxy→relayer is a
 * server-to-server call (no CORS). Net: the full MemWal flow works from
 * the browser with the delegate key never leaving the client unchanged
 * in trust terms (it's still only the signed envelope on the wire).
 */

const RELAYER_BASE = 'https://relayer.staging.memwal.ai';

/**
 * Request headers that describe THIS hop, not the relayer's. `host` must
 * be the relayer's; `content-length` is recomputed by fetch; stripping
 * `accept-encoding` makes the relayer reply with identity encoding so the
 * decoded body we forward back matches the headers we forward back.
 */
const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding']);

/**
 * Response headers that would corrupt the relayed body. `undici` already
 * decompresses the upstream body when we read it, so a stale
 * `content-encoding`/`content-length` would mislead the browser.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

// Never cache: this is a live credentialed relay of per-tick requests.
export const dynamic = 'force-dynamic';

// Cap relayed request bodies. MemWal calls are small JSON/text payloads; this
// bounds the proxy's memory use and its value as an anonymizing relay.
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

async function proxy(request: NextRequest, segments: string[]): Promise<Response> {
  const suffix = segments.map(encodeURIComponent).join('/');
  const target = `${RELAYER_BASE}/${suffix}${request.nextUrl.search}`;

  const forwardHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) forwardHeaders.set(key, value);
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let bodyBuf: ArrayBuffer | undefined;
  if (hasBody) {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return Response.json({ error: 'memwal-proxy: request body too large' }, { status: 413 });
    }
    bodyBuf = await request.arrayBuffer();
    if (bodyBuf.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'memwal-proxy: request body too large' }, { status: 413 });
    }
  }
  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders,
    redirect: 'manual',
    ...(bodyBuf ? { body: bodyBuf } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: 'memwal-proxy: upstream relayer unreachable', detail: message },
      { status: 502 },
    );
  }

  const body = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}

export async function PUT(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}

export async function PATCH(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  return proxy(request, (await ctx.params).path);
}
