import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { actionIds, actionPage, actionRpc, onlyKeys, readActionBatch } from '@/lib/photos/server/actions';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request),{offset,limit}=actionPage(request);
 return photoJson(await readActionBatch(actor,(await context.params).id,new URL(request.url).origin,offset,limit));
});}
export async function PATCH(request:Request,context:Context){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),body=await readPhotoJson(request),id=photoId((await context.params).id);
 onlyKeys(body,['action','photo_ids']);
 await actionRpc(actor,'photo_action_control',{p_actor:actor.actorId,p_batch_id:id,p_action:body.action,p_photo_ids:body.action==='skip'?actionIds(body.photo_ids):[]});
 return photoJson(await readActionBatch(actor,id,new URL(request.url).origin));
});}
