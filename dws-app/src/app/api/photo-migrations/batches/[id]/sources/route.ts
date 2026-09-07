import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId, readPhotoBatch } from '@/lib/photos/server/reads';
import { migrationPage, saveMigrationSource } from '@/lib/photos/server/migrations';
export async function POST(request: Request, context: {params:Promise<{id:string}>}) { return photoRoute(async () => {
  const actor=await requirePhotoActor(request,{mutation:true}); return photoJson({source:await saveMigrationSource(actor,(await context.params).id,await readPhotoJson(request))});
}); }
export async function GET(request: Request, context: {params:Promise<{id:string}>}) { return photoRoute(async () => {
  const actor=await requirePhotoActor(request); const id=photoId((await context.params).id); await readPhotoBatch(actor,id,'migration');
  const {limit,after}=migrationPage(request); let query=actor.db.from('migration_sources').select('*,jobs(id,job_number,name)').eq('batch_id',id).order('id').limit(limit+1);
  if(after) query=query.gt('id',after); const {data,error}=await query; if(error) throwPhotoDatabaseError(error);
  const sources=(data??[]).slice(0,limit); return photoJson({sources,next_cursor:(data?.length??0)>limit?sources.at(-1)!.id:null});
}); }
