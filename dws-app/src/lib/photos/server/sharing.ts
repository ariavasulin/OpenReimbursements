import 'server-only';
import type { PhotoActor } from './authority';
import { browserOrigin } from './browser-origin';
import { PhotoApiError, photoRpc } from './http';
import { photoId } from './reads';

// Share links (photo-albums plan, Phase 7, Decision 12). Two halves with different callers:
//   * the switch, for a signed-in employee (readShareStatus / setShare);
//   * the public read, for a visitor who is NOT signed in (readSharedPage).
// The public half follows the security contract written at the top of
// supabase/migrations/20260921040000_photo_share_links.sql. Read it before changing anything here.

/** Exactly one of an album or a project. */
export type ShareTarget = { p_album: string; p_job: null } | { p_album: null; p_job: string };
export function shareTarget(album: unknown, job: unknown): ShareTarget {
  const hasAlbum = album !== undefined && album !== null && album !== '', hasJob = job !== undefined && job !== null && job !== '';
  if (hasAlbum === hasJob) throw new PhotoApiError('invalid_input');
  return hasAlbum ? { p_album: photoId(album), p_job: null } : { p_album: null, p_job: photoId(job) };
}

/** Every generated link uses the one public photos address (Decision 13), never the request's host. */
export const shareUrl = (token: string) => `${browserOrigin()}/s/${token}`;

export interface ShareStatus {
  enabled: boolean;
  /** The link, shown again whenever the pop-up opens (Decision 12). Null when off. */
  url: string | null;
  created_at: string | null;
  /** False while an operator has share pages switched off for everyone: the link exists but nobody can open it. */
  pages_open?: boolean;
}
type ShareRow = { enabled: boolean; token: string | null; created_at: string | null; pages_open?: boolean };
const describe = (row: ShareRow): ShareStatus => ({ enabled: row.enabled, url: row.token ? shareUrl(row.token) : null, created_at: row.created_at,
  ...(row.pages_open === undefined ? {} : { pages_open: row.pages_open }) });

export async function readShareStatus(actor: PhotoActor, target: ShareTarget): Promise<ShareStatus> {
  return describe(await photoRpc(actor, 'photo_share_status', { p_actor: actor.actorId, ...target }));
}
export async function setShare(actor: PhotoActor, target: ShareTarget, enabled: unknown): Promise<ShareStatus> {
  if (typeof enabled !== 'boolean') throw new PhotoApiError('invalid_input');
  return describe(await photoRpc(actor, 'photo_share_set', { p_actor: actor.actorId, ...target, p_enabled: enabled }));
}

// ---- The public read ---------------------------------------------------------------------------

/** What a visitor gets for one photo: addresses and a capture date. No person, tag, XMP, or album. */
export interface SharedPhoto {
  id: string; kind: 'image' | 'video'; captured_at: string; name: string; duration_secs: number | null;
  thumb_url: string | null; preview_url: string | null; video_url: string | null; download_url: string;
}
export interface SharedPage { kind: 'album' | 'project'; name: string; count: number; photos: SharedPhoto[]; next: string | null }
type SharedRow = { id: string; kind: 'image' | 'video'; captured_at: string; original_name: string | null; mime_type: string | null; duration_secs: number | null;
  original_path: string; thumb_path: string | null; preview_path: string | null; playback_path: string | null };

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_PAGE_SIZE = 60;

/**
 * One page of a shared album or project, or null.
 *
 * NULL IS THE ONLY FAILURE. An unknown, malformed, revoked, or switched-off link, a bad cursor, and
 * a database that is down all return null, so the caller answers one identical 404 and a visitor
 * can learn nothing from the difference. It never throws.
 *
 * The target comes from the token inside photo_share_read. This function passes nothing else that
 * could select photos, and must never gain an album, project, or photo argument.
 */
export async function readSharedPage(token: unknown, cursor: unknown): Promise<SharedPage | null> {
  try {
    if (typeof token !== 'string' || !SHARE_TOKEN.test(token)) return null;
    let after: unknown = null;
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    }
    const { supabaseAdmin } = await import('@/lib/supabaseAdminClient');
    const { data, error } = await supabaseAdmin.rpc('photo_share_read', { p_token: token, p_after: after, p_limit: SHARE_PAGE_SIZE });
    if (error || !data) return null;
    const storage = supabaseAdmin.storage.from('photos');
    const address = (path: string | null) => path ? storage.getPublicUrl(path).data.publicUrl : null;
    return {
      kind: data.kind, name: data.name, count: Number(data.count),
      // Built field by field: nothing the database might add later can pass through by accident.
      photos: (data.photos as SharedRow[]).map(row => ({
        id: row.id, kind: row.kind, captured_at: row.captured_at, name: row.original_name ?? 'photo', duration_secs: row.duration_secs,
        thumb_url: address(row.thumb_path), preview_url: address(row.preview_path ?? row.thumb_path),
        video_url: row.kind === 'video' ? address(row.playback_path ?? row.original_path) : null,
        download_url: storage.getPublicUrl(row.original_path, { download: row.original_name || true }).data.publicUrl,
      })),
      next: data.next_after ? Buffer.from(JSON.stringify(data.next_after), 'utf8').toString('base64url') : null,
    };
  } catch { return null; }
}
