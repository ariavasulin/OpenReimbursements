import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { uploadRpc } from '@/lib/photos/server/uploads';
import { readMigrationBatch } from '@/lib/photos/server/migrations';
export async function GET(request: Request, context: {params:Promise<{id:string}>}) { return photoRoute(async () => {
  return photoJson(await readMigrationBatch(await requirePhotoActor(request),(await context.params).id));
}); }
export async function PATCH(request: Request, context: {params:Promise<{id:string}>}) { return photoRoute(async () => {
  const actor=await requirePhotoActor(request,{mutation:true}); const body=await readPhotoJson(request);
  return photoJson({batch:await uploadRpc(actor,'migration_batch_action',{p_actor:actor.actorId,p_batch:photoId((await context.params).id),p_action:body.action})});
}); }
