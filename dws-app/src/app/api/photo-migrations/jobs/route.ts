import { escapeIlikeWildcards } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { migrationPage } from '@/lib/photos/server/migrations';
export async function GET(request:Request) { return photoRoute(async()=>{
  const actor=await requirePhotoActor(request); const {params,limit}=migrationPage(request);
  let query=actor.db.from('jobs').select('id,job_number,name').eq('is_active',true).order('job_number').limit(limit);
  const q=params.get('q'); if(q) query=query.ilike('job_number',`%${escapeIlikeWildcards(q)}%`);
  const {data,error}=await query; if(error) throwPhotoDatabaseError(error); return photoJson({jobs:data});
}); }
