import { photoId } from '@/lib/photos/server/reads';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError, PhotoApiError, photoRpc } from '@/lib/photos/server/http';

import { migrationInteger } from '@/lib/photos/server/migrations';
export async function POST(request: Request) { return photoRoute(async () => {
  const actor = await requirePhotoActor(request, {mutation:true}); const body = await readPhotoJson(request);
  return photoJson({batch:await photoRpc(actor,'migration_create_batch',{p_actor:actor.actorId,p_script:body.script_name})});
}); }
export async function GET(request: Request) { return photoRoute(async () => {
  const actor = await requirePhotoActor(request); const params = new URL(request.url).searchParams;
  const limit = migrationInteger(Number(params.get('limit') ?? 50), 100);
  if (limit < 1) throw new PhotoApiError('invalid_input');
  let query=actor.db.from('migration_batches').select('id,created_by,script_name,status,approved_at,created_at,updated_at').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1);
  const after=params.get('after');
  if(after) {
    const [date,id]=after.split('~');
    if(!date || !/^[0-9TZ:.+-]+$/.test(date) || !Number.isFinite(Date.parse(date))) throw new PhotoApiError('invalid_input');
    query=query.or(`created_at.lt.${date},and(created_at.eq.${date},id.lt.${photoId(id)})`);
  }
  const {data,error}=await query; if(error) throwPhotoDatabaseError(error);
  const batches=(data??[]).slice(0,limit).map(batch=>({...batch,can_mutate:batch.created_by===actor.actorId}));
  const last=batches.at(-1); return photoJson({batches,next_cursor:(data?.length??0)>limit?`${last!.created_at}~${last!.id}`:null});
}); }
