import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { uploadRpc } from '@/lib/photos/server/uploads';
import { migrationInteger } from '@/lib/photos/server/migrations';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return photoRoute(async()=>{
  const actor=await requirePhotoActor(request,{mutation:true}); const body=await readPhotoJson(request);
  return photoJson({source:await uploadRpc(actor,'migration_seal',{p_actor:actor.actorId,p_source:photoId((await context.params).id),p_scan:photoId(body.scan_id),p_chunks:migrationInteger(body.chunk_count,2147483647),p_entries:migrationInteger(body.total_entries),p_bytes:migrationInteger(body.total_bytes),p_job:photoId(body.job_id),p_fingerprint:body.fingerprint})});
}); }
