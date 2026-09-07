import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { uploadRpc } from '@/lib/photos/server/uploads';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return photoRoute(async()=>{
  const actor=await requirePhotoActor(request,{mutation:true}); const body=await readPhotoJson(request);
  return photoJson({source:await uploadRpc(actor,'migration_scan',{p_actor:actor.actorId,p_source:photoId((await context.params).id),p_scan:photoId(body.scan_id)})});
}); }
