import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { createAction } from '@/lib/photos/server/actions';
import { SELECTION_BODY_BYTES } from '@/lib/photos/server/reads';
export async function POST(request:Request){return photoRoute(async()=>photoJson(await createAction(await requirePhotoActor(request,{mutation:true}),await readPhotoJson(request, SELECTION_BODY_BYTES),new URL(request.url).origin)));}
