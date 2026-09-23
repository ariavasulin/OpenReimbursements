import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, throwPhotoDatabaseError } from '@/lib/photos/server/http';
import { photoId } from '@/lib/photos/server/reads';
import { ACTION_PHOTO_COLUMNS } from '@/lib/photos/server/actions';
import type { ActionPhoto } from '@/lib/photos/action-types';

/** Intentional recovery view: retained, unexpired rows not marked for deletion forever, bounded cursor pages. */
export async function GET(request:Request){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request),params=new URL(request.url).searchParams,limit=Number(params.get('limit')??100);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new PhotoApiError('invalid_input');
 const now=new Date().toISOString();
 let query=actor.db.from('photos').select(ACTION_PHOTO_COLUMNS+',purge_claimed_at').not('deleted_at','is',null).gt('purge_after',now).is('purge_claimed_at',null).order('id').limit(limit+1);
 if(params.has('after')) query=query.gt('id',photoId(params.get('after')));
 if(params.has('job_id')) query=query.eq('job_id',photoId(params.get('job_id')));
 const {data,error}=await query;if(error) throwPhotoDatabaseError(error);
 const rows=(data??[]).slice(0,limit) as unknown as (ActionPhoto&{purge_claimed_at:string|null})[];
 const ids=[...new Set(rows.flatMap(row=>row.duplicate_of?[row.duplicate_of]:[]))];
 const canonical=ids.length?await actor.db.from('photos').select(ACTION_PHOTO_COLUMNS+',purge_claimed_at').in('id',ids):{data:[],error:null};
 if(canonical.error) throwPhotoDatabaseError(canonical.error);
 const canonicalRows=(canonical.data??[]) as unknown as (ActionPhoto&{purge_claimed_at:string|null})[];
 const byId=new Map(canonicalRows.map(row=>[row.id,row]));
 const photos=rows.map(row=>{
   const target=row.duplicate_of?byId.get(row.duplicate_of):row;
   const retained=Boolean(target&&!target.duplicate_of&&(!target.deleted_at||(target.purge_after&&target.purge_after>now&&!target.purge_claimed_at)));
   const {purge_claimed_at: _claim,...photo}=row;
   return {...photo,canonical_photo:row.duplicate_of?target??null:null,can_restore:retained,
     remedy:!retained?'The canonical photo is unavailable for recovery.':row.duplicate_of?'This legacy duplicate resolves to its canonical photo. Review the canonical target before restoring.':null};
 });
 return photoJson({photos,next_cursor:(data??[]).length>limit?photos.at(-1)!.id:null});
});}
