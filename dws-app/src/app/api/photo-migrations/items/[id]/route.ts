import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { migrationItemAction } from '@/lib/photos/server/migrations';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}); return photoJson({item:await migrationItemAction(actor,(await context.params).id,await readPhotoJson(request))});
}); }
