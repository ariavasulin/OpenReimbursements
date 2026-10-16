import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute } from '@/lib/photos/server/http';
import { actionPage, referenceCandidates, selectorReference } from '@/lib/photos/server/actions';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request),url=new URL(request.url),index=Number(url.searchParams.get('reference_index'));
 // Only the one reference asked about, not the whole selection (VIEW-1).
 const ref=await selectorReference(actor,(await context.params).id,index),{offset,limit}=actionPage(request);
 if(!ref) throw new PhotoApiError('invalid_input');
 return photoJson(await referenceCandidates(actor,ref,url.origin,offset,limit));
});}
