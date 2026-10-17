import { requirePhotoActor, requirePhotoAdmin } from '@/lib/photos/server/authority';
import { onlyKeys } from '@/lib/photos/server/actions';
import { PhotoApiError, photoJson, photoRoute, photoRpc, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId, requirePhotoReader } from '@/lib/photos/server/reads';
import { mapJobSummary } from '@/lib/photos/jobSummary';
import type { PhotoJobSummaryRow } from '@/lib/photos/types';

interface RouteContext { params: Promise<{ id: string }> }

// GET /api/photo-jobs/[id] — one active project as its card shows it, for the
// project page's header when no list in the browser holds it yet, so opening a
// project by link does not wait for every project. 404 when it is deleted or
// unknown. The same summary function as the list, so the two always agree.
export async function GET(_request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const supabase = await requirePhotoReader();
    const id = photoId((await context.params).id);
    const { data, error } = await supabase.rpc('get_photo_job_summaries', { search_query: null })
      .eq('id', id).maybeSingle();
    if (error) throwPhotoDatabaseError(error);
    if (!data) throw new PhotoApiError('not_found');
    return photoJson({ success: true, job: mapJobSummary(data as PhotoJobSummaryRow) });
  });
}

// PATCH /api/photo-jobs/[id] { name, job_number? }  — rename a project, and change
//       its number when one is sent. A number another project holds is a 409.
// PATCH /api/photo-jobs/[id] { action: 'restore' }  — bring a deleted project back
//       within 30 days, with the photos that went to Trash together with it.
export async function PATCH(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    const id = photoId((await context.params).id), body = await readPhotoJson(request);
    if ('action' in body) {
      onlyKeys(body, ['action']);
      if (body.action !== 'restore') throw new PhotoApiError('invalid_input');
      return photoJson(await photoRpc(actor, 'photo_restore_job', { p_actor: actor.actorId, p_job: id }));
    }
    onlyKeys(body, ['name', 'job_number']);
    if (typeof body.name !== 'string' || (body.job_number !== undefined && typeof body.job_number !== 'string')) {
      throw new PhotoApiError('invalid_input');
    }
    return photoJson(await photoRpc(actor, 'photo_rename_job', {
      p_actor: actor.actorId, p_job_id: id, p_name: body.name, p_job_number: body.job_number ?? null,
    }));
  });
}

// DELETE /api/photo-jobs/[id] — delete a project: it and every photo in it go to
// Trash for 30 days. Repeating it is safe and does not restart the 30 days.
// Photo admins only (403 otherwise).
export async function DELETE(request: Request, context: RouteContext) {
  return photoRoute(async () => {
    const actor = await requirePhotoActor(request, { mutation: true });
    requirePhotoAdmin(actor);
    const id = photoId((await context.params).id);
    return photoJson(await photoRpc(actor, 'photo_delete_job', { p_actor: actor.actorId, p_job: id }));
  });
}
