import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { PhotoApiError, photoRoute, throwPhotoDatabaseError } from './http';

const codeOf = (error: { code?: string; message?: string }) => {
  try { throwPhotoDatabaseError(error); } catch (thrown) {
    expect(thrown).toBeInstanceOf(PhotoApiError);
    return (thrown as PhotoApiError).code;
  }
};

describe('throwPhotoDatabaseError', () => {
  // /me, /actor and /settings read the cookie without asking Auth, so PostgREST
  // refusing the token is how a forged or expired cookie is turned away: it
  // must come out as a sign-in problem (401), not "temporarily unavailable" (503).
  it.each(['PGRST301', 'PGRST302', 'PGRST303'])('maps PostgREST token refusal %s to unauthenticated', (code) => {
    expect(codeOf({ code, message: 'JWSError JWSInvalidSignature' })).toBe('unauthenticated');
  });

  it('answers a refused token with 401 through photoRoute', async () => {
    const response = await photoRoute(async () => throwPhotoDatabaseError({ code: 'PGRST301', message: 'JWT expired' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sign in to continue.', retryable: false } });
  });

  it('keeps unknown database errors private and retryable', () => {
    expect(codeOf({ code: 'PGRST000', message: 'connection refused' })).toBe('temporarily_unavailable');
  });
});
