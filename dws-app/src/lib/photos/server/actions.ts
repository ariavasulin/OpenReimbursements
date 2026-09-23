import 'server-only';
import type { ActionPhoto, PhotoActionBatch, PhotoActionBatchResponse, PhotoReference, PhotoSelector } from '../action-types';
import { assertPhotoBatchActor, type PhotoActor } from './authority';
import { photoId } from './reads';
import { MAX_BULK_PHOTOS } from '../apiShared';
import { PhotoApiError, throwPhotoDatabaseError, photoRpc, photoLinkIds } from './http';

export const ACTION_PHOTO_COLUMNS = 'id,job_id,uploader_id,original_name,display_name,kind,thumb_path,deleted_at,purge_after,duplicate_of,job:jobs(id,job_number,name,deleted_at)';
export function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new PhotoApiError('invalid_input');
}
export function actionPage(request: Request) {
  const search = new URL(request.url).searchParams;
  const offset = Number(search.get('offset') ?? 0), limit = Number(search.get('limit') ?? 100);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PhotoApiError('invalid_input');
  return {offset, limit};
}
export function validateSelector(value: unknown): PhotoSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PhotoApiError('invalid_input');
  const selector = value as Record<string, unknown>;
  if ('photos' in selector) {
    onlyKeys(selector, ['photos']);
    if (!Array.isArray(selector.photos) || selector.photos.length < 1 || selector.photos.length > MAX_BULK_PHOTOS) throw new PhotoApiError('invalid_input');
    for (const ref of selector.photos) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new PhotoApiError('invalid_input');
      if ('photo_id' in ref) { onlyKeys(ref, ['photo_id']); photoId(ref.photo_id); }
      else if ('photo_url' in ref) { onlyKeys(ref, ['photo_url']); if (typeof ref.photo_url !== 'string' || ref.photo_url.length > 2048) throw new PhotoApiError('invalid_input'); }
      else { onlyKeys(ref, ['job_number','original_filename']); if (typeof ref.job_number !== 'string' || !ref.job_number.trim() || ref.job_number.length>128 || typeof ref.original_filename !== 'string' || !ref.original_filename || ref.original_filename.length>512) throw new PhotoApiError('invalid_input'); }
    }
  } else {
    onlyKeys(selector, ['job_number','scope']);
    if (typeof selector.job_number !== 'string' || !selector.job_number.trim() || selector.job_number.length>128 || !['active','trash'].includes(String(selector.scope))) throw new PhotoApiError('invalid_input');
  }
  return selector as PhotoSelector;
}
export async function getActionBatch(actor:PhotoActor,id:string):Promise<PhotoActionBatch> {
  const {data,error}=await actor.db.from('photo_action_batches').select('*,destination_job:jobs(id,job_number,name)').eq('id',photoId(id)).maybeSingle();
  if(error) throwPhotoDatabaseError(error);
  if(!data) throw new PhotoApiError('not_found');
  return data as unknown as PhotoActionBatch;
}
/** Parse known application links; this resolver never performs HTTP requests. */
function referenceId(ref:PhotoReference, origin:string):string|null {
  if ('photo_id' in ref) return photoId(ref.photo_id);
  if (!('photo_url' in ref)) return null;
  const ids=photoLinkIds(ref.photo_url,origin);
  // `/photos?photo=<id>` names no project; an older link's project must still be a UUID.
  if(ids.jobId!==null) photoId(ids.jobId);
  return photoId(ids.photoId);
}
export async function referenceCandidates(actor:PhotoActor,ref:PhotoReference,origin:string,offset=0,limit=100) {
  const id=referenceId(ref,origin);
  let query=actor.db.from('photos').select(ACTION_PHOTO_COLUMNS,{count:'exact'}).order('id').range(offset,offset+limit-1);
  if(id) query=query.eq('id',id);
  else if('job_number' in ref) {
    const job=await actor.db.from('jobs').select('id').eq('job_number',ref.job_number).maybeSingle();
    if(job.error) throwPhotoDatabaseError(job.error);
    if(!job.data) return {candidates:[],total:0};
    query=query.eq('job_id',job.data.id).eq('original_name',ref.original_filename);
  }
  const {data,error,count}=await query;
  if(error) throwPhotoDatabaseError(error);
  return {candidates:(data??[]) as unknown as ActionPhoto[],total:count??0};
}
export async function readActionBatch(actor:PhotoActor,id:string,origin:string,offset=0,limit=100):Promise<PhotoActionBatchResponse> {
  const batch=await getActionBatch(actor,id);
  const selected=await actor.db.from('photo_action_items').select('*',{count:'exact'}).eq('batch_id',id).order('photo_id').range(offset,offset+limit-1);
  if(selected.error) throwPhotoDatabaseError(selected.error);
  const ids=(selected.data??[]).map(row=>row.photo_id);
  const photos=ids.length ? await actor.db.from('photos').select(ACTION_PHOTO_COLUMNS).in('id',ids) : {data:[],error:null};
  if(photos.error) throwPhotoDatabaseError(photos.error);
  const byId=new Map((photos.data??[]).map(row=>[row.id,row]));
  let can_mutate=true;
  try {await assertPhotoBatchActor(actor,id,'action');} catch(error) {if(!(error instanceof PhotoApiError)||error.code!=='forbidden') throw error;can_mutate=false;}
  const unresolved:PhotoActionBatchResponse['unresolved']=[];
  if(batch.status==='draft'&&!batch.materialization_complete&&'photos' in batch.selector) {
    const index=Number(batch.materialization_cursor??0), ref=batch.selector.photos[index];
    if(ref) {const result=await referenceCandidates(actor,ref,origin);if(result.total!==1) unresolved.push({reference_index:index,reference:ref,reason:result.total?'ambiguous':'not_found',...result});}
  }
  return {batch,items:(selected.data??[]).map(row=>({...row,photo:byId.get(row.photo_id)??null})) as PhotoActionBatchResponse['items'],total:selected.count??0,can_mutate,unresolved};
}
export async function materializeAction(actor:PhotoActor,id:string,origin:string,body:Record<string,unknown>) {
  onlyKeys(body,['choices']);
  const batch=await getActionBatch(actor,id);
  await assertPhotoBatchActor(actor,id,'action');
  if(batch.status!=='draft') throw new PhotoApiError('conflict');
  if(batch.materialization_complete) return readActionBatch(actor,id,origin);
  const selector=validateSelector(batch.selector);
  let ids:string[]=[],next:string|null=null,complete=false;
  if('photos' in selector) {
    const index=Number(batch.materialization_cursor??0),ref=selector.photos[index];
    const choices=body.choices??{};
    if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).some(key=>key!==String(index))) throw new PhotoApiError('invalid_input');
    // Explicit IDs from the selection grid are unambiguous. Resolve a bounded
    // page together, stopping before a missing photo so it still needs a choice.
    if (body.choices === undefined && 'photo_id' in ref) {
      const page: string[] = [];
      for (const candidate of selector.photos.slice(index, index + 100)) {
        if (!('photo_id' in candidate)) break;
        page.push(candidate.photo_id);
      }
      const found = await actor.db.from('photos').select('id').in('id', page);
      if (found.error) throwPhotoDatabaseError(found.error);
      const existing = new Set((found.data ?? []).map(row => row.id));
      const missing = page.findIndex(id => !existing.has(id));
      ids = missing < 0 ? page : page.slice(0, missing);
      if (ids.length) {
        const cursor = index + ids.length;
        await photoRpc(actor, 'photo_materialize_action', {
          p_actor: actor.actorId, p_batch_id: id, p_cursor: batch.materialization_cursor,
          p_ids: ids, p_next_cursor: String(cursor), p_complete: cursor === selector.photos.length,
        });
        return readActionBatch(actor, id, origin);
      }
    }
    const choice=(choices as Record<string,unknown>)[index];
    if(choice===null) { /* Explicit unresolved-reference skip; no target is added. */ }
    else {
      if(choice!==undefined) {
        const chosen=photoId(choice);
        // Validate choices independently of the candidate preview's pagination.
        const chosenRow=await actor.db.from('photos').select('id,job_id,original_name').eq('id',chosen).maybeSingle();
        if(chosenRow.error) throwPhotoDatabaseError(chosenRow.error);
        if(!chosenRow.data) throw new PhotoApiError('invalid_input');
        if('job_number' in ref) {
          const job=await actor.db.from('jobs').select('id').eq('job_number',ref.job_number).maybeSingle();
          if(job.error) throwPhotoDatabaseError(job.error);
          if(job.data?.id!==chosenRow.data.job_id||chosenRow.data.original_name!==ref.original_filename) throw new PhotoApiError('invalid_input');
        } else if(referenceId(ref,origin)!==chosen) throw new PhotoApiError('invalid_input');
        ids=[chosen];
      } else {
        const candidates=await referenceCandidates(actor,ref,origin);
        if(candidates.total===1) ids=[candidates.candidates[0].id];
        else return readActionBatch(actor,id,origin);
      }
    }
    next=String(index+1);complete=index+1===selector.photos.length;
  } else {
    if(body.choices!==undefined) throw new PhotoApiError('invalid_input');
    const job=await actor.db.from('jobs').select('id').eq('job_number',selector.job_number).maybeSingle();
    if(job.error) throwPhotoDatabaseError(job.error);
    if(!job.data) throw new PhotoApiError('invalid_input');
    let query=actor.db.from('photos').select('id').eq('job_id',job.data.id).order('id').limit(101);
    query=selector.scope==='active'?query.is('deleted_at',null):query.not('deleted_at','is',null);
    if(batch.materialization_cursor) query=query.gt('id',photoId(batch.materialization_cursor));
    const {data,error}=await query;if(error) throwPhotoDatabaseError(error);
    ids=(data??[]).slice(0,100).map(row=>row.id);next=ids.at(-1)??batch.materialization_cursor;complete=(data??[]).length<=100;
  }
  await photoRpc(actor,'photo_materialize_action',{p_actor:actor.actorId,p_batch_id:id,p_cursor:batch.materialization_cursor,p_ids:ids,p_next_cursor:next,p_complete:complete});
  return readActionBatch(actor,id,origin);
}
export async function createAction(actor:PhotoActor,body:Record<string,unknown>,origin:string) {
  onlyKeys(body,['action','selector','destination_job_id']);
  if(!['move','trash','restore'].includes(String(body.action))) throw new PhotoApiError('invalid_input');
  const selector=validateSelector(body.selector);
  const destination=body.destination_job_id==null?null:photoId(body.destination_job_id);
  // A move must say where: a project id, or an explicit null meaning "No project".
  // A move that leaves the key out is still refused, so a forgotten destination
  // can never empty a photo's project.
  if(body.action==='move'&&body.destination_job_id===undefined||body.action==='trash'&&destination) throw new PhotoApiError('invalid_input');
  if(destination){const job=await actor.db.from('jobs').select('id').eq('id',destination).eq('is_active',true).maybeSingle();if(job.error) throwPhotoDatabaseError(job.error);if(!job.data) throw new PhotoApiError('invalid_input');}
  // Validate URL references on draft creation, before persisting any input.
  if('photos' in selector) for(const ref of selector.photos) referenceId(ref,origin);
  const {data,error}=await actor.db.from('photo_action_batches').insert({created_by:actor.actorId,origin:body.action==='move'?'ui':'ordinary',action:body.action,selector,destination_job_id:destination}).select('id').single();
  if(error) throwPhotoDatabaseError(error);
  return readActionBatch(actor,data.id,origin);
}
export function actionIds(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length||value.length>100) throw new PhotoApiError('invalid_input');
  return [...new Set(value.map(photoId))];
}
