import 'server-only';
import type { PhotoActor } from './authority';

const errors = {
  invalid_input: [400, 'Invalid request.'],
  unauthenticated: [401, 'Sign in to continue.'],
  forbidden: [403, 'This action is not permitted.'],
  not_found: [404, 'The requested record was not found.'],
  conflict: [409, 'The record changed or has already been used.'],
  handoff_expired: [410, 'This handoff has expired.'],
  payload_too_large: [413, 'The request is too large.'],
  rate_limited: [429, 'Please try again later.'],
  temporarily_unavailable: [503, 'Photo operations are temporarily unavailable.'],
} as const;

export class PhotoApiError extends Error {
  constructor(public readonly code: keyof typeof errors) {
    super(errors[code][1]);
  }
}

export function photoJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' },
  });
}

/** No database messages, tokens, or arbitrary upstream errors cross this boundary. */
export async function photoRoute(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof PhotoApiError ? error.code : 'temporarily_unavailable';
    return photoJson({ error: {
      code, message: errors[code][1],
      retryable: code === 'temporarily_unavailable' || code === 'rate_limited',
    } }, errors[code][0]);
  }
}

export function requireSameOrigin(request: Request): void {
  // Do not derive the accepted origin from an untrusted forwarded header.
  if (request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new PhotoApiError('forbidden');
  }
}

/** Bound bytes while reading, including bodies without Content-Length. */
export async function readPhotoJson(request: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new PhotoApiError('invalid_input');
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new PhotoApiError('payload_too_large');
  }
  if (!request.body) throw new PhotoApiError('invalid_input');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new PhotoApiError('payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new PhotoApiError('invalid_input');
  }
}

/** SQL messages are fixed server codes; unknown diagnostics remain private. */
export function throwPhotoDatabaseError(error: { code?: string; message?: string }): never {
  const message = error.message;
  if (message === 'invalid_input') throw new PhotoApiError('invalid_input');
  if (message === 'invalid_actor') throw new PhotoApiError('unauthenticated');
  if (message === 'handoff_expired') throw new PhotoApiError('handoff_expired');
  if (error.code === '42501' || message === 'forbidden' || message === 'wrong_consumer' || message === 'wrong_script') {
    throw new PhotoApiError('forbidden');
  }
  if (message === 'not_found' || message === 'handoff_not_found') throw new PhotoApiError('not_found');
  if (error.code === '23505' || ['handoff_consumed', 'conflict', 'stale_lease', 'stale_claim', 'lease_busy'].includes(message ?? '')) {
    throw new PhotoApiError('conflict');
  }
  throw new PhotoApiError('temporarily_unavailable');
}

export async function photoRpc(actor: PhotoActor, name: string, args: Record<string, unknown>) {
  const { data, error } = await actor.db.rpc(name, args);
  if (error) throwPhotoDatabaseError(error);
  return data;
}

/** Parse application links without fetching them; callers validate their UUIDs. */
export function photoLinkIds(reference: string, origin: string) {
  let url: URL;
  try { url = new URL(reference, origin); } catch { throw new PhotoApiError('invalid_input'); }
  if (![origin, 'https://design-workshops.app', 'https://photos.design-workshops.app', 'https://dws-receipts.com', 'https://www.dws-receipts.com', 'https://photos.dws-receipts.com'].includes(url.origin) ||
      url.username || url.password || !/^\/photos\/[0-9a-f-]+\/?$/i.test(url.pathname)) throw new PhotoApiError('invalid_input');
  return { jobId: url.pathname.split('/')[2], photoId: url.searchParams.get('photo') };
}
