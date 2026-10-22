import 'server-only';

/**
 * Client for the shop bridge: the read-only query service on the shop's Windows box,
 * reached through a Cloudflare Tunnel. See Docs/shop-bridge-runbook.md.
 *
 * The bridge runs only queries named in its own config; callers pick one by name
 * (POST /query/<name>) and may pass its parameters. It accepts no SQL.
 *
 * Env (all server-only): SHOP_BRIDGE_URL, SHOP_BRIDGE_TOKEN, CF_ACCESS_CLIENT_ID,
 * CF_ACCESS_CLIENT_SECRET. The Cloudflare pair is optional only when calling the bridge
 * on a LAN without the tunnel (tests, the shop box itself).
 */

export type ShopParams = Record<string, string | number | boolean | null>;
export type ShopQueryOptions = { maxRows?: number; timeoutMs?: number };
export type ShopQueryResult<T> = {
  columns: string[];
  rows: T[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};
export type ShopHealth = {
  ok: boolean;
  server?: string;
  database?: string;
  version?: string;
  mirror?: unknown;
  /** Names of the queries the bridge's config defines: mirrored ones and live (callable) ones. */
  queries?: { mirror: string[]; live: string[] };
  durationMs?: number;
  error?: unknown;
};

/**
 * Codes come from the bridge's error envelope ({ error: { code, message } }), e.g.
 * not_found (404, no query by that name) or bad_request (400), or from this client:
 * not_configured, timeout, unreachable, edge_blocked, bad_response, http_<status>.
 */
export class ShopBridgeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ShopBridgeError';
  }
}

type Config = { url: string; token: string; accessId?: string; accessSecret?: string };
type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 20_000;
const QUERY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function config(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.SHOP_BRIDGE_URL;
  const token = env.SHOP_BRIDGE_TOKEN;
  if (!url || !token) throw new ShopBridgeError('Shop bridge is not configured', 503, 'not_configured');
  return {
    url: url.replace(/\/+$/, ''),
    token,
    accessId: env.CF_ACCESS_CLIENT_ID || undefined,
    accessSecret: env.CF_ACCESS_CLIENT_SECRET || undefined,
  };
}

function headers(c: Config): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${c.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (c.accessId && c.accessSecret) {
    h['CF-Access-Client-Id'] = c.accessId;
    h['CF-Access-Client-Secret'] = c.accessSecret;
  }
  return h;
}

async function call<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const c = config(deps.env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${c.url}${path}`, {
      ...init,
      headers: headers(c),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ShopBridgeError('Shop bridge timed out', 504, 'timeout');
    }
    throw new ShopBridgeError('Shop bridge unreachable', 502, 'unreachable');
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    // Cloudflare Access answers a blocked service call with 403 (or a 302 to its login
    // page when it thinks a browser is calling). Neither reaches the bridge.
    const edge = res.status === 403 || res.status === 302 || (res.status >= 300 && res.status < 400);
    const err = (body as { error?: { code?: string; message?: string } | string } | null)?.error;
    const code =
      typeof err === 'object' && err?.code ? err.code : edge ? 'edge_blocked' : `http_${res.status}`;
    const message =
      typeof err === 'object' && err?.message
        ? err.message
        : typeof err === 'string'
          ? err
          : edge
            ? 'Blocked at the Cloudflare edge (check CF_ACCESS_CLIENT_ID/SECRET and the Access policy)'
            : `Shop bridge returned ${res.status}`;
    throw new ShopBridgeError(message, res.status, code);
  }
  if (body === null) throw new ShopBridgeError('Shop bridge returned no JSON', 502, 'bad_response');
  return body as T;
}

/** Run one of the bridge's named queries on the shop database and return the full result. */
export async function shopQueryResult<T = Record<string, unknown>>(
  name: string,
  params?: ShopParams,
  options: ShopQueryOptions = {},
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<ShopQueryResult<T>> {
  if (!QUERY_NAME.test(name)) throw new ShopBridgeError(`Invalid shop query name: ${JSON.stringify(name)}`, 400, 'bad_request');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload: { params?: ShopParams; maxRows?: number } = {};
  if (params !== undefined) payload.params = params;
  if (options.maxRows !== undefined) payload.maxRows = options.maxRows;
  return call<ShopQueryResult<T>>(`/query/${name}`, { method: 'POST', body: JSON.stringify(payload) }, timeoutMs, deps);
}

/** Run one of the bridge's named queries on the shop database and return its rows. */
export async function shopQuery<T = Record<string, unknown>>(
  name: string,
  params?: ShopParams,
  options: ShopQueryOptions = {},
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<T[]> {
  const result = await shopQueryResult<T>(name, params, options, deps);
  return result.rows;
}

/** The bridge's own health report (SQL Server reachability, version, mirror status, query names). */
export async function shopHealth(
  deps: { fetchImpl?: FetchLike; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ShopHealth> {
  return call<ShopHealth>('/health', { method: 'GET' }, deps.timeoutMs ?? 10_000, deps);
}
