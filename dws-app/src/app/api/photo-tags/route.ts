import { validate as isUuid } from 'uuid';
import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import type { PhotoTagRow } from '@/lib/photos/types';
import { invalidFilter, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { requirePhotoReader } from '@/lib/photos/server/reads';

// GET /api/photo-tags?job=&q= — distinct tags in use (optionally scoped to a
// job, optionally substring-filtered), for the Tags filter and upload
// type-ahead. Answers no-store, per user (photoJson), like every photo read.

export async function GET(request: Request) {
  return photoRoute(async () => {
    const supabase = await requirePhotoReader();
    const params = new URL(request.url).searchParams;
    const job = params.get('job');
    const q = params.get('q')?.trim() ?? '';
    if (job && !isUuid(job)) return invalidFilter('Invalid job id');

    const escaped = escapeIlikeWildcards(q);
    const { data, error } = await supabase.rpc('get_photo_tags', {
      job_filter: job || null,
      q: escaped || null,
    });
    if (error) throwPhotoDatabaseError(error);
    const tags = ((data ?? []) as PhotoTagRow[]).map((row) => row.tag);
    return photoJson({ success: true, tags });
  });
}
