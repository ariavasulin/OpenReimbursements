import { readSharedPage } from '@/lib/photos/server/sharing';

// THE ONLY PUBLIC API ROUTE IN THE APP. No login. It reads through the service role, so what it may
// return is decided entirely by public.photo_share_read (see the security contract at the top of
// supabase/migrations/20260921040000_photo_share_links.sql):
//   * the target comes from the token and from nothing in the request;
//   * every failure -- unknown, malformed, revoked, switched off for everyone, bad cursor, database
//     down -- is ONE identical 404, so a visitor learns nothing from the difference;
//   * nothing is cached and nothing is indexed, so turning a link off takes effect at once.
// It deliberately does not use photoRoute/photoJson: those answer 401/503/`Vary: Cookie`, which
// would make a closed gate look different from an unknown token.

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
const notFound = () => Response.json({ error: { code: 'not_found', message: 'This link is not available.' } }, { status: 404, headers: HEADERS });

/** `?after=<cursor from the previous page's "next">` -> `{ kind, name, count, photos, next }`. */
export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const page = await readSharedPage(token, new URL(request.url).searchParams.get('after'));
    return page ? Response.json(page, { headers: HEADERS }) : notFound();
  } catch { return notFound(); }
}
