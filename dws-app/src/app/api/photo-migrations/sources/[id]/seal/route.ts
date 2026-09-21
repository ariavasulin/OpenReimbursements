import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { sealMigrationSource } from '@/lib/photos/server/migrations';

export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return photoRoute(async()=>{
  const actor=await requirePhotoActor(request,{mutation:true}); const body=await readPhotoJson(request);
  return photoJson({source:await sealMigrationSource(actor,(await context.params).id,body)});
}); }
