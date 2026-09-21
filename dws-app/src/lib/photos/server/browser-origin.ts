import 'server-only';
import { assertNoConfiguredSecrets } from '@/lib/mcp/secrets';
import { PhotoApiError } from './http';

/**
 * The address every generated link uses: MCP hand-offs and share links alike (photo-albums
 * Decision 13). It comes from DWS_BROWSER_ORIGIN, never from the incoming request's host, so a
 * link minted through any connector or domain points at the one public photos address.
 * Moved here from the MCP registry, which re-exports it, so a share route does not load the MCP SDK.
 */
export function browserOrigin(): string {
  const url = new URL(process.env.DWS_BROWSER_ORIGIN ?? 'https://photos.design-workshops.app');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new PhotoApiError('temporarily_unavailable');
  }
  assertNoConfiguredSecrets(url.href);
  return url.origin;
}
