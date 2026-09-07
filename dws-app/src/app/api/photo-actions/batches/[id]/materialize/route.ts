import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { materializeAction } from '@/lib/photos/server/actions';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return photoRoute(async()=>photoJson(await materializeAction(await requirePhotoActor(request,{mutation:true}),(await context.params).id,new URL(request.url).origin,await readPhotoJson(request))))}
