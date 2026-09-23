import { cleanPhotoName, cleanTags, PHOTO_COLUMNS } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError, photoRpc } from '@/lib/photos/server/http';
import { photoId, readPhotoOwnership, requirePhotoReader } from '@/lib/photos/server/reads';
import { createAction, materializeAction, onlyKeys } from '@/lib/photos/server/actions';
interface RouteContext { params:Promise<{id:string}> }

/**
 * One active photo by id, with its project (or null) and the live albums it is in.
 * This is what lets `/photos?photo=<id>` open any photo, however old and with or
 * without a project, instead of paging a list until the id turns up. A trashed or
 * unknown id is 404. Read through the employee's session, like the list.
 */
export async function GET(_request:Request,context:RouteContext){return photoRoute(async()=>{
 const session=await requirePhotoReader(),id=photoId((await context.params).id);
 const {data,error}=await session.from('photos').select(PHOTO_COLUMNS+', albums(id, name)').eq('id',id).is('deleted_at',null)
  .order('name',{referencedTable:'albums'}).order('id',{referencedTable:'albums'}).maybeSingle();
 if(error) throwPhotoDatabaseError(error);if(!data) throw new PhotoApiError('not_found');
 return photoJson({success:true,photo:data});
});}

/**
 * Metadata edits apply only to active rows. Ownership changes require confirmation.
 * `display_name` renames the photo as people see and download it; an empty name
 * (or null) goes back to the uploaded filename, which never changes.
 */
export async function PATCH(request:Request,context:RouteContext){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),id=photoId((await context.params).id),body=await readPhotoJson(request);
 onlyKeys(body,['tags','display_name']);
 if(!('tags' in body)&&!('display_name' in body)) throw new PhotoApiError('invalid_input');
 if('tags' in body&&(!Array.isArray(body.tags)||body.tags.some(tag=>typeof tag!=='string'))) throw new PhotoApiError('invalid_input');
 if('display_name' in body){
  if(body.display_name!==null&&typeof body.display_name!=='string') throw new PhotoApiError('invalid_input');
  const name=cleanPhotoName(body.display_name);if(name==='invalid') throw new PhotoApiError('photo_name_invalid');
  await photoRpc(actor,'photo_rename_photo',{p_actor:actor.actorId,p_photo:id,p_name:name});
 }
 const photos=actor.session.from('photos');
 const {data,error}=Array.isArray(body.tags)
  ? await photos.update({tags:cleanTags(body.tags)}).eq('id',id).is('deleted_at',null).select(PHOTO_COLUMNS).maybeSingle()
  : await photos.select(PHOTO_COLUMNS).eq('id',id).is('deleted_at',null).maybeSingle();
 if(error) throwPhotoDatabaseError(error);if(!data) throw new PhotoApiError('not_found');
 return photoJson({success:true,photo:data});
});}

/** Compatibility single-target confirmation, open to any signed-in employee; no Storage objects are removed here. */
export async function DELETE(request:Request,context:RouteContext){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),id=photoId((await context.params).id),photo=await readPhotoOwnership(actor,id);
 // Replay preserves the original deletion instant and its fixed retention deadline.
 if(photo.deleted_at) return photoJson({success:true,photo_id:id,deleted_at:photo.deleted_at,purge_after:photo.purge_after});
 const origin=new URL(request.url).origin;
 const created=await createAction(actor,{action:'trash',selector:{photos:[{photo_id:id}]}},origin);
 await materializeAction(actor,created.batch.id,origin,{});
 await photoRpc(actor,'photo_approve_action',{p_actor:actor.actorId,p_batch_id:created.batch.id});
 const outcomes=await photoRpc(actor,'photo_execute_action',{p_actor:actor.actorId,p_batch_id:created.batch.id,p_photo_ids:[id]});
 if(outcomes[0]?.status!=='applied') throw new PhotoApiError('conflict');
 const retained=await readPhotoOwnership(actor,id);
 return photoJson({success:true,photo_id:id,deleted_at:retained.deleted_at,purge_after:retained.purge_after});
});}
