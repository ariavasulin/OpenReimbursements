import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson, photoRpc } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { onlyKeys, readActionBatch } from '@/lib/photos/server/actions';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),id=photoId((await context.params).id);onlyKeys(await readPhotoJson(request),[]);
 await photoRpc(actor,'photo_approve_action',{p_actor:actor.actorId,p_batch_id:id});
 return photoJson(await readActionBatch(actor,id,new URL(request.url).origin));
});}
