import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson } from '@/lib/photos/server/http';
import { prepareMigrationUpload, MigrationIdentityChanged } from '@/lib/photos/server/migrations';
export async function POST(request:Request) { return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}); try { return photoJson(await prepareMigrationUpload(actor,await readPhotoJson(request))); }
 catch (error) {
   if (error instanceof MigrationIdentityChanged) return photoJson({error:{code:'conflict',message:'This file changed. Start a fresh attempt before retrying.',retryable:false},new_attempt_required:true},409);
   throw error;
 }
}); }
