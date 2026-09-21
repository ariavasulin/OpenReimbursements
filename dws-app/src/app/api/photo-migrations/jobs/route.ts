import { escapeForIlike } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { migrationPage } from '@/lib/photos/server/migrations';
/** Active projects for import review. `q` matches the project number or its name. */
export async function GET(request:Request) { return photoRoute(async()=>{
  const actor=await requirePhotoActor(request); const {params,limit}=migrationPage(request);
  let query=actor.db.from('jobs').select('id,job_number,name').eq('is_active',true).order('job_number').limit(limit);
  // The value sits inside an or() filter, so it goes through the helper that also strips that grammar.
  const q=escapeForIlike(params.get('q')??''); if(q) query=query.or(`job_number.ilike.%${q}%,name.ilike.%${q}%`);
  const {data,error}=await query; if(error) throwPhotoDatabaseError(error); return photoJson({jobs:data});
}); }
