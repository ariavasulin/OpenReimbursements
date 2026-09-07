import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute } from '@/lib/photos/server/http';
import { actionPage, getActionBatch, referenceCandidates } from '@/lib/photos/server/actions';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request),batch=await getActionBatch(actor,(await context.params).id),url=new URL(request.url),index=Number(url.searchParams.get('reference_index')),{offset,limit}=actionPage(request);
 if(!Number.isSafeInteger(index)||index<0||!('photos' in batch.selector)||!batch.selector.photos[index]) throw new PhotoApiError('invalid_input');
 return photoJson(await referenceCandidates(actor,batch.selector.photos[index],url.origin,offset,limit));
});}
