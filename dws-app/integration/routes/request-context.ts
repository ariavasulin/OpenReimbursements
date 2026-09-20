import { AsyncLocalStorage } from 'node:async_hooks';

/** Only adapts Next's request-local cookie API; Auth still verifies real cookies. */
export const requestContext = new AsyncLocalStorage<{
  cookies: Map<string, string>;
  headers: Headers;
}>();

export function withRequest<T>(
  request: Request,
  cookies: Array<{ name: string; value: string }>,
  work: () => T,
): T {
  const headers = new Headers(request.headers);
  headers.set('host', new URL(request.url).host);
  return requestContext.run({ cookies: new Map(cookies.map(c => [c.name, c.value])), headers }, work);
}
