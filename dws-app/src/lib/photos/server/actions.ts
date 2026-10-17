import 'server-only';
import type { ActionPhoto, PhotoActionBatch, PhotoActionBatchResponse, PhotoReference, PhotoSelector } from '../action-types';
import { assertPhotoBatchActor, type PhotoActor } from './authority';
import { photoId } from './reads';
import { MAX_SELECTION_PHOTOS } from '../apiShared';
import { PhotoApiError, throwPhotoDatabaseError, photoRpc, photoLinkIds } from './http';
import { canTrashPhoto, trashRefusedFilter } from '../permissions';

export const ACTION_PHOTO_COLUMNS = 'id,job_id,uploader_id,created_at,original_name,display_name,kind,thumb_path,deleted_at,purge_after,duplicate_of,job:jobs(id,job_number,name,deleted_at)';
/** Who may trash this photo (permissions.ts), so a trash list can stop at a photo SQL would refuse and ask about it instead. */
export const mayTrash = (actor: PhotoActor, photo: { uploader_id: string; created_at: string }) =>
  canTrashPhoto({ user_id: actor.actorId, photo_admin: actor.isPhotoAdmin }, photo);
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
    if (!Array.isArray(selector.photos) || selector.photos.length < 1 || selector.photos.length > MAX_SELECTION_PHOTOS) throw new PhotoApiError('invalid_input');
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
/**
 * A batch as responses carry it: every column but `selector`. The selector names
 * the whole selection (about 255 KB for 5,000 photos), and every confirm-page
 * response used to repeat it, page after page (VIEW-1). The few places that need
 * it read it themselves: materializeAction whole, the rest one reference at a time.
 */
export type StoredActionBatch = Omit<PhotoActionBatch, 'selector'>;
/**
 * Compatibility stub for one release; delete it (and `selector` below) next round.
 * A confirm page whose script loaded before this deploy reads
 * `'photos' in next.batch.selector` on every materialize answer, and `in` throws
 * on undefined. Vercel Hobby has no skew protection, so an open Set project or
 * Trash page would fail with a script error. An empty object makes that old code
 * read "0 wanted" and show "Getting the photo ready…" instead; the current page
 * uses `selection_size` and never reads this.
 */
const LEGACY_SELECTOR_STUB: Record<string, never> = Object.freeze({});
/** What the batch routes answer: the batch without its selector (see StoredActionBatch), plus the stub above. */
export type ActionBatchAnswer = Omit<PhotoActionBatchResponse, 'batch'> & { batch: StoredActionBatch & { selector: Record<string, never> } };
/**
 * POST .../materialize also says how many references the selection names (null
 * for a whole project), so the confirm page can show "N of M" without the selector.
 */
export type MaterializeAnswer = ActionBatchAnswer & { selection_size: number | null };
const BATCH_COLUMNS = 'id,created_by,origin,action,destination_job_id,status,approved_by,approved_at,created_at,updated_at,materialization_complete,materialization_cursor,destination_job:jobs(id,job_number,name)';

async function readBatchRow(actor:PhotoActor,id:string,columns:string) {
  const {data,error}=await actor.db.from('photo_action_batches').select(columns).eq('id',photoId(id)).maybeSingle();
  if(error) throwPhotoDatabaseError(error);
  if(!data) throw new PhotoApiError('not_found');
  return data as unknown;
}
export async function getActionBatch(actor:PhotoActor,id:string):Promise<StoredActionBatch> {
  return await readBatchRow(actor,id,BATCH_COLUMNS) as StoredActionBatch;
}
/** One reference from a `{photos}` selector by its index, without the rest; null past the end or for a whole-project selector. */
export async function selectorReference(actor:PhotoActor,id:string,index:number):Promise<PhotoReference|null> {
  // The row is read even for a bad index, so an unknown batch is still a 404 first.
  const valid=Number.isSafeInteger(index)&&index>=0;
  const row=await readBatchRow(actor,id,valid?`ref:selector->photos->${index}`:'id') as {ref?:PhotoReference|null};
  return valid?row.ref??null:null;
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
/**
 * One page of a batch for the confirm page. `selector` is passed by callers that
 * already hold it, which saves reading the next reference back. The reads that do
 * not depend on each other go out together.
 */
export async function readActionBatch(actor:PhotoActor,id:string,origin:string,offset=0,limit=100,selector?:PhotoSelector):Promise<ActionBatchAnswer> {
  const batch=await getActionBatch(actor,id);
  // A `{photos}` selector's cursor is the index of the next reference; a project-wide one's is a photo id.
  const index=Number(batch.materialization_cursor??0);
  const drafting=batch.status==='draft'&&!batch.materialization_complete&&Number.isSafeInteger(index);
  const nextRef=async():Promise<PhotoReference|null>=>{
    if(!drafting) return null;
    if(selector) return 'photos' in selector?selector.photos[index]??null:null;
    return selectorReference(actor,id,index);
  };
  const mutable=async()=>{
    try {await assertPhotoBatchActor(actor,id,'action');return true;}
    catch(error) {if(!(error instanceof PhotoApiError)||error.code!=='forbidden') throw error;return false;}
  };
  const [selected,can_mutate,ref]=await Promise.all([
    actor.db.from('photo_action_items').select('*',{count:'exact'}).eq('batch_id',id).order('photo_id').range(offset,offset+limit-1),
    mutable(),
    nextRef(),
  ]);
  if(selected.error) throwPhotoDatabaseError(selected.error);
  const ids=(selected.data??[]).map(row=>row.photo_id);
  const [photos,result]=await Promise.all([
    ids.length ? actor.db.from('photos').select(ACTION_PHOTO_COLUMNS).in('id',ids) : {data:[],error:null},
    ref ? referenceCandidates(actor,ref,origin) : null,
  ]);
  if(photos.error) throwPhotoDatabaseError(photos.error);
  const byId=new Map((photos.data??[]).map(row=>[row.id,row]));
  const unresolved:PhotoActionBatchResponse['unresolved']=[];
  if(ref&&result) {
    if(result.total!==1) unresolved.push({reference_index:index,reference:ref,reason:result.total?'ambiguous':'not_found',...result});
    // One match this person may not trash (an assistant's list can name anyone's photo): ask to leave it out.
    else if(batch.action==='trash'&&!mayTrash(actor,result.candidates[0])) unresolved.push({reference_index:index,reference:ref,reason:'forbidden',...result});
  }
  return {batch:{...batch,selector:LEGACY_SELECTOR_STUB},items:(selected.data??[]).map(row=>({...row,photo:byId.get(row.photo_id)??null})) as PhotoActionBatchResponse['items'],total:selected.count??0,can_mutate,unresolved};
}
export async function materializeAction(actor:PhotoActor,id:string,origin:string,body:Record<string,unknown>):Promise<MaterializeAnswer> {
  onlyKeys(body,['choices']);
  // The one step that needs the whole selector, so the one read of it.
  const batch=await readBatchRow(actor,id,`${BATCH_COLUMNS},selector`) as PhotoActionBatch;
  await assertPhotoBatchActor(actor,id,'action');
  if(batch.status!=='draft') throw new PhotoApiError('conflict');
  const stored=batch.selector as Partial<{photos:PhotoReference[]}>;
  const selection_size=Array.isArray(stored.photos)?stored.photos.length:null;
  const answer=async():Promise<MaterializeAnswer>=>({...await readActionBatch(actor,id,origin,0,100,batch.selector),selection_size});
  if(batch.materialization_complete) return answer();
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
      const found = await actor.db.from('photos').select('id,uploader_id,created_at').in('id', page);
      if (found.error) throwPhotoDatabaseError(found.error);
      // A trash list also stops before a photo this person may not trash, which then needs an answer.
      const usable = new Set((found.data ?? []).filter(row => batch.action !== 'trash' || mayTrash(actor, row)).map(row => row.id));
      const missing = page.findIndex(id => !usable.has(id));
      ids = missing < 0 ? page : page.slice(0, missing);
      if (ids.length) {
        const cursor = index + ids.length;
        await photoRpc(actor, 'photo_materialize_action', {
          p_actor: actor.actorId, p_batch_id: id, p_cursor: batch.materialization_cursor,
          p_ids: ids, p_next_cursor: String(cursor), p_complete: cursor === selector.photos.length,
        });
        return answer();
      }
    }
    const choice=(choices as Record<string,unknown>)[index];
    if(choice===null) { /* Explicit unresolved-reference skip; no target is added. */ }
    else {
      if(choice!==undefined) {
        const chosen=photoId(choice);
        // Validate choices independently of the candidate preview's pagination.
        const chosenRow=await actor.db.from('photos').select('id,job_id,original_name,uploader_id,created_at').eq('id',chosen).maybeSingle();
        if(chosenRow.error) throwPhotoDatabaseError(chosenRow.error);
        if(!chosenRow.data) throw new PhotoApiError('invalid_input');
        if(batch.action==='trash'&&!mayTrash(actor,chosenRow.data)) throw new PhotoApiError('forbidden');
        if('job_number' in ref) {
          const job=await actor.db.from('jobs').select('id').eq('job_number',ref.job_number).maybeSingle();
          if(job.error) throwPhotoDatabaseError(job.error);
          if(job.data?.id!==chosenRow.data.job_id||chosenRow.data.original_name!==ref.original_filename) throw new PhotoApiError('invalid_input');
        } else if(referenceId(ref,origin)!==chosen) throw new PhotoApiError('invalid_input');
        ids=[chosen];
      } else {
        const candidates=await referenceCandidates(actor,ref,origin);
        if(candidates.total===1&&(batch.action!=='trash'||mayTrash(actor,candidates.candidates[0]))) ids=[candidates.candidates[0].id];
        else return answer();
      }
    }
    next=String(index+1);complete=index+1===selector.photos.length;
  } else {
    if(body.choices!==undefined) throw new PhotoApiError('invalid_input');
    const job=await actor.db.from('jobs').select('id').eq('job_number',selector.job_number).maybeSingle();
    if(job.error) throwPhotoDatabaseError(job.error);
    if(!job.data) throw new PhotoApiError('invalid_input');
    const scopeIs=selector.scope==='active'?'is':'not.is';
    // A project-wide trash is all or nothing, so a non-admin is turned away with the rule before
    // any page is added, instead of meeting SQL's bare refusal once a page is in.
    if(batch.action==='trash'&&!actor.isPhotoAdmin) {
      const refused=await actor.db.from('photos').select('id',{count:'exact',head:true}).eq('job_id',job.data.id).filter('deleted_at',scopeIs,null).or(trashRefusedFilter(actor.actorId));
      if(refused.error) throwPhotoDatabaseError(refused.error);
      if((refused.count??0)>0) throw new PhotoApiError('trash_rule');
    }
    const query=actor.db.from('photos').select('id').eq('job_id',job.data.id).filter('deleted_at',scopeIs,null).order('id').limit(101);
    const {data,error}=await (batch.materialization_cursor?query.gt('id',photoId(batch.materialization_cursor)):query);if(error) throwPhotoDatabaseError(error);
    ids=(data??[]).slice(0,100).map(row=>row.id);next=ids.at(-1)??batch.materialization_cursor;complete=(data??[]).length<=100;
  }
  await photoRpc(actor,'photo_materialize_action',{p_actor:actor.actorId,p_batch_id:id,p_cursor:batch.materialization_cursor,p_ids:ids,p_next_cursor:next,p_complete:complete});
  return answer();
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
  return readActionBatch(actor,data.id,origin,0,100,selector);
}
export function actionIds(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length||value.length>100) throw new PhotoApiError('invalid_input');
  return [...new Set(value.map(photoId))];
}
