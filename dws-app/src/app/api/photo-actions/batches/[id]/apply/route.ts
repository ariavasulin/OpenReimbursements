import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { actionIds, actionRpc, onlyKeys } from '@/lib/photos/server/actions';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),body=await readPhotoJson(request);onlyKeys(body,['photo_ids']);
 return photoJson({outcomes:await actionRpc(actor,'photo_execute_action',{p_actor:actor.actorId,p_batch_id:photoId((await context.params).id),p_photo_ids:actionIds(body.photo_ids)})});
});}
