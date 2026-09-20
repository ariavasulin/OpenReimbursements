import { cleanSheet, cleanTags, PHOTO_COLUMNS } from '@/lib/photos/apiShared';
import { requirePhotoActor } from '@/lib/photos/server/authority';
import { PhotoApiError, photoJson, photoRoute, readPhotoJson, throwPhotoDatabaseError, photoRpc } from '@/lib/photos/server/http';
import { canManageOwnPhoto, photoId, readPhotoOwnership } from '@/lib/photos/server/reads';
import { createAction, materializeAction, onlyKeys } from '@/lib/photos/server/actions';
interface RouteContext { params:Promise<{id:string}> }

/** Metadata edits apply only to active rows. Ownership changes require confirmation. */
export async function PATCH(request:Request,context:RouteContext){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),id=photoId((await context.params).id),body=await readPhotoJson(request);
 onlyKeys(body,['sheet_number','tags']);
 const updates:Record<string,unknown>={};
 if('sheet_number' in body){if(body.sheet_number!==null&&typeof body.sheet_number!=='string') throw new PhotoApiError('invalid_input');updates.sheet_number=cleanSheet(body.sheet_number);}
 if('tags' in body){if(!Array.isArray(body.tags)||body.tags.some(tag=>typeof tag!=='string')) throw new PhotoApiError('invalid_input');updates.tags=cleanTags(body.tags);}
 if(!Object.keys(updates).length) throw new PhotoApiError('invalid_input');
 const {data,error}=await actor.session.from('photos').update(updates).eq('id',id).is('deleted_at',null).select(PHOTO_COLUMNS).maybeSingle();
 if(error) throwPhotoDatabaseError(error);if(!data) throw new PhotoApiError('not_found');
 return photoJson({success:true,photo:data});
});}

/** Compatibility single-target confirmation; no Storage objects are removed here. */
export async function DELETE(request:Request,context:RouteContext){return photoRoute(async()=>{
 const actor=await requirePhotoActor(request,{mutation:true}),id=photoId((await context.params).id),photo=await readPhotoOwnership(actor,id);
 if(!await canManageOwnPhoto(actor,photo.uploader_id)) throw new PhotoApiError('forbidden');
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
