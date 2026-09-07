import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { assertNoConfiguredSecrets } from './secrets';

afterEach(() => vi.unstubAllEnvs());
describe('MCP configured-secret boundary', () => {
  it('rejects values and keys anywhere in nested input without reflecting them', () => {
    vi.stubEnv('MCP_SHARED_KEY', 'a'.repeat(64));
    vi.stubEnv('DWS_GITHUB_ISSUES_TOKEN', 'github-private-test-value');
    for (const input of [
      { sources: [{ label: 'a'.repeat(64) }] },
      { selector: { photos: [{ photo_url: `https://photos.dws-receipts.com/${'a'.repeat(64)}` }] } },
      { tags: ['github-private-test-value'] },
      { ['github-private-test-value']: 'ordinary' },
    ]) expect(() => assertNoConfiguredSecrets(input)).toThrow('Invalid request.');
  });
  it('recognizes configured credentials even when percent-encoded in a URL', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sensitive+value/secret');
    const encoded = encodeURIComponent(encodeURIComponent('sensitive+value/secret'));
    expect(() => assertNoConfiguredSecrets({ photo_url: `https://example.test/${encoded}` })).toThrow('Invalid request.');
  });
  it('does not treat public configuration as private, and tolerates ordinary nested input', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'public-test-key');
    expect(() => assertNoConfiguredSecrets({ tags: ['public-test-key'], label: 'Job 3612', refs: [null, 1, true] })).not.toThrow();
  });
});
