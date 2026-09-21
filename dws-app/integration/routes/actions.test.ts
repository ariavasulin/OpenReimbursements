import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFixtures, type FixtureActor } from '../fixtures';
import { withRequest } from './request-context';
vi.mock('next/headers', async()=>{const {requestContext}=await import('./request-context');return {
 cookies:async()=>({get:(name:string)=>{const value=requestContext.getStore()!.cookies.get(name);return value===undefined?undefined:{name,value}},set:(name:string,value:string)=>{requestContext.getStore()!.cookies.set(name,value)}}),headers:async()=>requestContext.getStore()!.headers,
};});
import { POST as create } from '@/app/api/photo-actions/batches/route';
import { GET as read, PATCH as control } from '@/app/api/photo-actions/batches/[id]/route';
import { POST as materialize } from '@/app/api/photo-actions/batches/[id]/materialize/route';
import { POST as approve } from '@/app/api/photo-actions/batches/[id]/approve/route';
import { POST as apply } from '@/app/api/photo-actions/batches/[id]/apply/route';
import { POST as consume } from '@/app/api/photo-migrations/handoffs/consume/route';
import { DELETE as remove, PATCH as edit } from '@/app/api/photos/[id]/route';
import { GET as dedupe } from '@/app/api/photos/dedupe/route';
import type { PhotoActionBatchResponse } from '@/lib/photos/action-types';

describe('exact confirmed action routes (AC-5, AC-7, AC-8, AC-9)',()=>{
 let f:Awaited<ReturnType<typeof createFixtures>>;
 const context=(id:string)=>({params:Promise.resolve({id})});
 beforeAll(async()=>{f=await createFixtures()});afterAll(async()=>{await f?.close()});
 beforeEach(async()=>{expect((await f.admin.from('photo_release_state').upsert({singleton:true,schema_generation:1,photo_writes_enabled:true,mcp_enabled:true,repair_enabled:true})).error).toBeNull()});
 async function call(handler:(r:Request,c:ReturnType<typeof context>)=>Promise<Response>,id:string,body?:unknown,actor:FixtureActor=f.employeeA,method='POST',query=''){
  const request=new Request(`http://localhost:3000/api/photo-actions/batches/${id}${query}`,{method,headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body??{})})});
  return withRequest(request,actor.cookies,()=>handler(request,context(id)));
 }
 async function json(response:Response,status=200){const body=await response.json();expect(response.status,JSON.stringify(body)).toBe(status);expect(response.headers.get('cache-control')).toBe('no-store');return body}
 async function job(){const id=randomUUID();const number=`actions-${id}`;expect((await f.admin.from('jobs').insert({id,job_number:number,name:'Action fixture'})).error).toBeNull();return {id,number}}
 async function photo(jobId:string,extra:Record<string,unknown>={}){const id=randomUUID();expect((await f.admin.from('photos').insert({id,job_id:jobId,uploader_id:f.employeeA.id,kind:'image',captured_at:new Date().toISOString(),original_path:`originals/${f.employeeA.id}/${id}/file.jpg`,original_name:'file.jpg',...extra})).error).toBeNull();return id}
 async function draft(action:string,selector:unknown,destination?:string,actor=f.employeeA){return json(await call(create,'',{action,selector,...(destination?{destination_job_id:destination}:{})},actor)) as Promise<PhotoActionBatchResponse>}
 async function seal(id:string,actor=f.employeeA){let result:PhotoActionBatchResponse;do{result=await json(await call(materialize,id,{},actor));if(result.unresolved.length)throw new Error('Unexpected unresolved reference')}while(!result.batch.materialization_complete);return result;}
 async function confirm(id:string,actor=f.employeeA){await seal(id,actor);return json(await call(approve,id,{},actor)) as Promise<PhotoActionBatchResponse>}
 async function handoff(action:string,selector:unknown,destination?:string,actor=f.employeeB){const token=randomBytes(32).toString('base64url'),script=action==='trash'?'remove_photos':`${action}_photos`;expect((await f.admin.from('dws_action_handoffs').insert({token_digest:createHash('sha256').update(token).digest('hex'),script_name:script,requested_input:{selector,...(destination?{destination_job_number:destination}:{})},expires_at:new Date(Date.now()+60_000).toISOString()})).error).toBeNull();return (await json(await call(consume,'',{token,script_name:script},actor))).photo_action_batch_id as string;}
 const selected=(ids:string[])=>({photos:ids.map(photo_id=>({photo_id}))});

 it('freezes20 confirmed IDs, leaves21st untouched, preserves retention on replay, and blocks target additions',async()=>{
  const j=await job(),ids=[];for(let i=0;i<20;i++)ids.push(await photo(j.id));
  const d=await draft('trash',{job_number:j.number,scope:'active'});const approved=await confirm(d.batch.id);expect(approved.total).toBe(20);
  const added=await photo(j.id);
  const first=await json(await call(apply,d.batch.id,{photo_ids:ids}));expect(first.outcomes).toHaveLength(20);expect(first.outcomes.every((o:{status:string})=>o.status==='applied')).toBe(true);
  const retained=await f.admin.from('photos').select('id,deleted_at,purge_after').in('id',ids);
  expect(await json(await call(apply,d.batch.id,{photo_ids:ids}))).toEqual(first);
  expect((await f.admin.from('photos').select('id,deleted_at,purge_after').in('id',ids)).data).toEqual(retained.data);
  expect((await f.admin.from('photos').select('deleted_at').eq('id',added).single()).data?.deleted_at).toBeNull();
  await json(await call(materialize,d.batch.id,{}),409);
  expect((await f.admin.from('photo_action_items').insert({batch_id:d.batch.id,photo_id:added,expected_job_id:j.id})).error?.message).toBe('conflict');
  expect((await json(await call(read,d.batch.id,undefined,f.employeeA,'GET'))).batch.status).toBe('completed');
 });
 it('processes a changed owning job as an individual conflict, resumes independent targets, and skips explicitly',async()=>{
  const from=await job(),to=await job(),third=await job(),a=await photo(from.id),b=await photo(from.id);
  const d=await draft('move',selected([a,b]),to.id);await confirm(d.batch.id);
  await f.sql.query('update public.photos set job_id=$1 where id=$2',[third.id,a]);
  const result=await json(await call(apply,d.batch.id,{photo_ids:[a,b]}));expect(result.outcomes.map((o:{status:string})=>o.status)).toEqual(['conflict','applied']);
  expect((await json(await call(read,d.batch.id,undefined,f.employeeA,'GET'))).batch.status).toBe('interrupted');
  const retry=await json(await call(apply,d.batch.id,{photo_ids:[b]}));expect(retry.outcomes[0].status).toBe('applied');
  const skipped=await json(await call(control,d.batch.id,{action:'skip',photo_ids:[a]},f.employeeA,'PATCH'));expect(skipped.batch.status).toBe('completed');
 });
 it('denies wrong batch actors and forged origin/script/action changes, while any employee may target a colleague’s photo',async()=>{
  const from=await job(),to=await job(),id=await photo(from.id,{uploader_id:f.employeeB.id});
  const d=await draft('move',selected([id]),to.id);await confirm(d.batch.id);
  expect((await json(await call(read,d.batch.id,undefined,f.employeeB,'GET'))).can_mutate).toBe(false);
  await json(await call(apply,d.batch.id,{photo_ids:[id]},f.employeeB),403);
  await json(await call(apply,d.batch.id,{photo_ids:[id],action:'trash'}),400);
  await json(await call(create,'',{action:'trash',origin:'mcp',selector:selected([id])}),400);
  await json(await call(control,d.batch.id,{action:'trash'},f.employeeA,'PATCH'),400);
  // employeeA did not upload this photo; the uploader-or-admin check is gone (photo-albums Decision 7).
  const own=await draft('trash',selected([id]));const listed=await json(await call(materialize,own.batch.id,{}));expect(listed.items.map((item:{photo_id:string})=>item.photo_id)).toEqual([id]);
  expect((await f.admin.from('photo_action_batches').update({action:'trash'}).eq('id',d.batch.id)).error).not.toBeNull();
  expect((await json(await call(apply,d.batch.id,{photo_ids:[id]}))).outcomes[0].status).toBe('applied');
 });
 it('matching another owner’s trash offers an ordinary restore; MCP restore moves canonical and resolves dedupe',async()=>{
  const from=await job(),to=await job(),digest=randomBytes(32).toString('hex'),id=await photo(from.id,{content_sha256:digest});
  await json(await call(remove,id,{},f.employeeA,'DELETE'));
  const request=new Request(`http://localhost:3000/api/photos/dedupe?sha256=${digest}`);
  const duplicate=await json(await withRequest(request,f.employeeB.cookies,()=>dedupe(request)));expect(duplicate.can_restore).toBe(true);expect(duplicate.remedy).toBe('Confirm restoration before uploading.');
  const d=await draft('restore',selected([id]),undefined,f.employeeB);expect((await json(await call(materialize,d.batch.id,{},f.employeeB))).items).toHaveLength(1);
  const mcp=await handoff('restore',selected([id]),to.number);await confirm(mcp,f.employeeB);
  expect((await json(await call(apply,mcp,{photo_ids:[id]},f.employeeB))).outcomes[0].status).toBe('applied');
  expect((await f.admin.from('photos').select('deleted_at,job_id,content_sha256').eq('id',id).single()).data).toEqual({deleted_at:null,job_id:to.id,content_sha256:digest});
  expect((await json(await withRequest(request,f.employeeB.cookies,()=>dedupe(request)))).status).toBe('duplicate_active');
 });
 it('resolves a legacy duplicate into an explicit canonical confirmation, preserving the duplicate and indexed identity',async()=>{
  const from=await job(),to=await job(),digest=randomBytes(32).toString('hex'),canonical=await photo(from.id,{content_sha256:digest});
  await json(await call(remove,canonical,{},f.employeeA,'DELETE'));
  const retained=(await f.admin.from('photos').select('deleted_at,purge_after,deleted_by').eq('id',canonical).single()).data!;
  const legacy=await photo(from.id,{...retained,duplicate_of:canonical,legacy_content_sha256:digest});
  const id=await handoff('restore',selected([legacy]),to.number);const review=await seal(id,f.employeeB);
  expect(review.items).toHaveLength(1);expect(review.items[0]).toMatchObject({photo_id:canonical,requested_photo_id:legacy});
  await json(await call(approve,id,{},f.employeeB));await json(await call(apply,id,{photo_ids:[canonical]},f.employeeB));
  expect((await f.admin.from('photos').select('deleted_at').eq('id',legacy).single()).data?.deleted_at).toBe(retained.deleted_at);
  expect((await f.admin.from('photos').select('id').eq('content_sha256',digest)).data).toEqual([{id:canonical}]);
 });
 it('rejects an expired target independently while restoring an unexpired target',async()=>{
  const j=await job(),expired=await photo(j.id),valid=await photo(j.id);for(const id of [expired,valid])await json(await call(remove,id,{},f.employeeA,'DELETE'));
  await f.sql.query("update public.photos set deleted_at=now()-interval '31 days',purge_after=now()-interval '1 day' where id=$1",[expired]);
  const d=await draft('restore',selected([expired,valid]));await confirm(d.batch.id);
  const result=await json(await call(apply,d.batch.id,{photo_ids:[expired,valid]}));expect(result.outcomes.map((o:{status:string})=>o.status)).toEqual(['conflict','applied']);
 });
 it('requires selection for ambiguous names, keeps zero matches unresolved, and parses only app links',async()=>{
  const j=await job(),a=await photo(j.id),b=await photo(j.id);
  const d=await draft('move',{photos:[{job_number:j.number,original_filename:'file.jpg'}]},j.id);
  const unresolved=await json(await call(materialize,d.batch.id,{}));expect(unresolved.unresolved[0].total).toBe(2);expect(unresolved.total).toBe(0);
  await json(await call(approve,d.batch.id,{}),409);
  const resolved=await json(await call(materialize,d.batch.id,{choices:{0:b}}));expect(resolved.items[0].photo_id).toBe(b);
  const missing=await draft('trash',{photos:[{job_number:j.number,original_filename:'missing.jpg'}]});expect((await json(await call(materialize,missing.batch.id,{}))).unresolved[0].reason).toBe('not_found');
  const url=await draft('move',{photos:[{photo_url:`http://localhost:3000/photos/${j.id}?photo=${a}`}]},j.id);expect((await seal(url.batch.id)).items[0].photo_id).toBe(a);
  await json(await call(create,'',{action:'move',destination_job_id:j.id,selector:{photos:[{photo_url:`https://evil.example/photos/${j.id}?photo=${a}`}]}}),400);
 });

 it('rejects expired legacy aliases and records expiry after confirmation without touching an active canonical',async()=>{
  const from=await job(),to=await job(),canonical=await photo(from.id),valid=await photo(from.id);
  const deleted=new Date(Date.now()-86400000).toISOString(),expires=new Date(Date.now()+29*86400000).toISOString();
  const legacy=await photo(from.id,{duplicate_of:canonical,legacy_content_sha256:randomBytes(32).toString('hex'),deleted_at:deleted,deleted_by:f.employeeA.id,purge_after:expires});
  const b=await handoff('restore',selected([legacy,valid]),to.number);await confirm(b,f.employeeB);
  await f.sql.query("update public.photos set deleted_at=now()-interval '31 days',purge_after=now()-interval '1 day' where id=$1",[legacy]);
  const result=await json(await call(apply,b,{photo_ids:[canonical,valid]},f.employeeB));expect(result.outcomes.map((o:{status:string})=>o.status)).toEqual(['conflict','applied']);
  expect((await f.admin.from('photos').select('job_id,deleted_at').eq('id',canonical).single()).data).toEqual({job_id:from.id,deleted_at:null});
  const expired=await handoff('restore',selected([legacy]),to.number);await json(await call(materialize,expired,{},f.employeeB),409);
 });
 it('materializes a205-target selector across bounded pages and refuses partial approval',async()=>{
  const j=await job(),to=await job();
  const photos=Array.from({length:205},()=>{const id=randomUUID();return {id,job_id:j.id,uploader_id:f.employeeA.id,kind:'image',captured_at:new Date().toISOString(),original_path:`originals/${f.employeeA.id}/${id}/fixture.jpg`}});
  expect((await f.admin.from('photos').insert(photos)).error).toBeNull();
  const d=await draft('move',{job_number:j.number,scope:'active'},to.id);
  const first=await json(await call(materialize,d.batch.id,{}));expect(first.total).toBe(100);expect(first.batch.materialization_complete).toBe(false);expect(first.items).toHaveLength(100);
  await json(await call(approve,d.batch.id,{}),409);
  expect((await json(await call(materialize,d.batch.id,{}))).total).toBe(200);
  const final=await json(await call(materialize,d.batch.id,{}));expect(final.total).toBe(205);expect(final.batch.materialization_complete).toBe(true);
  expect((await json(await call(read,d.batch.id,undefined,f.employeeA,'GET','?offset=200&limit=100'))).items).toHaveLength(5);
  await json(await call(approve,d.batch.id,{}));
 });
 it('ordinary delete is open to any employee and records them, PATCH rejects job edits and trash, and cancellation fences apply',async()=>{
  const j=await job(),id=await photo(j.id),other=await photo(j.id,{uploader_id:f.employeeB.id});
  const first=await json(await call(remove,other,{},f.employeeA,'DELETE'));
  expect((await f.admin.from('photos').select('deleted_by').eq('id',other).single()).data?.deleted_by).toBe(f.employeeA.id);
  // A replay by anyone keeps the original deletion instant, deadline, and actor.
  expect(await json(await call(remove,other,{},f.administrator,'DELETE'))).toEqual(first);
  expect((await f.admin.from('photos').select('deleted_by').eq('id',other).single()).data?.deleted_by).toBe(f.employeeA.id);
  await json(await call(edit,id,{job_id:j.id},f.employeeA,'PATCH'),400);
  await json(await call(edit,other,{tags:['new']},f.employeeB,'PATCH'),404);
  const d=await draft('trash',selected([id]));await confirm(d.batch.id);await json(await call(control,d.batch.id,{action:'cancel'},f.employeeA,'PATCH'));await json(await call(apply,d.batch.id,{photo_ids:[id]}),409);
  expect((await f.admin.from('photos').select('deleted_at').eq('id',id).single()).data?.deleted_at).toBeNull();
 });

 // photo-albums AC-5. employeeA uploads every fixture photo; employeeB is an ordinary employee, not an administrator.
 it('lets employee B trash then restore employee A’s photo and records B; signed out is 401 and a closed gate is 503',async()=>{
  const j=await job(),id=await photo(j.id);
  const state=async()=>(await f.admin.from('photos').select('uploader_id,deleted_at,deleted_by,purge_after').eq('id',id).single()).data!;
  const removeRequest=()=>new Request(`http://localhost:3000/api/photos/${id}`,{method:'DELETE',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:'{}'});
  const draftRequest=()=>new Request('http://localhost:3000/api/photo-actions/batches',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'application/json'},body:JSON.stringify({action:'restore',selector:selected([id])})});

  // Signed out: neither the trash route nor the restore draft is reachable, and nothing changes.
  for(const [request,handler] of [[removeRequest(),(r:Request)=>remove(r,context(id))],[draftRequest(),(r:Request)=>create(r)]] as const){
   const response=await withRequest(request,[],()=>handler(request));expect(response.status).toBe(401);expect((await response.json()).error.code).toBe('unauthenticated');
  }
  expect((await state()).deleted_at).toBeNull();

  // Gate closed: a signed-in employee gets 503, and nothing changes.
  expect((await f.admin.from('photo_release_state').update({photo_writes_enabled:false}).eq('singleton',true)).error).toBeNull();
  for(const [request,handler] of [[removeRequest(),(r:Request)=>remove(r,context(id))],[draftRequest(),(r:Request)=>create(r)]] as const){
   const response=await withRequest(request,f.employeeB.cookies,()=>handler(request));expect(response.status).toBe(503);expect((await response.json()).error.code).toBe('temporarily_unavailable');
  }
  expect((await state()).deleted_at).toBeNull();
  expect((await f.admin.from('photo_release_state').update({photo_writes_enabled:true}).eq('singleton',true)).error).toBeNull();

  // Trash: B is neither the uploader nor an administrator, and it succeeds with deleted_by = B.
  await json(await call(remove,id,{},f.employeeB,'DELETE'));
  const trashed=await state();
  expect(trashed.uploader_id).toBe(f.employeeA.id);expect(trashed.deleted_by).toBe(f.employeeB.id);expect(trashed.deleted_at).not.toBeNull();
  expect(new Date(trashed.purge_after).getTime()-new Date(trashed.deleted_at).getTime()).toBe(30*86400_000);

  // Restore through the ordinary confirm flow, still as B.
  const d=await draft('restore',selected([id]),undefined,f.employeeB);await confirm(d.batch.id,f.employeeB);
  const applied=await json(await call(apply,d.batch.id,{photo_ids:[id]},f.employeeB));expect(applied.outcomes[0].status).toBe('applied');
  expect(await state()).toMatchObject({uploader_id:f.employeeA.id,deleted_at:null,deleted_by:null,purge_after:null});
  // Batch ownership is unchanged: A cannot drive the batch B created.
  await json(await call(apply,d.batch.id,{photo_ids:[id]},f.employeeA),403);
 });

 // photo-albums AC-4. The route is strict about keys, so a removed field is refused rather than silently dropped.
 it('PATCH has no sheet_number parameter: it is refused, writes nothing, and the photo carries no such field',async()=>{
  const j=await job(),id=await photo(j.id,{tags:['before']});
  await json(await call(edit,id,{sheet_number:'A-1'},f.employeeA,'PATCH'),400);
  await json(await call(edit,id,{sheet_number:'A-1',tags:['after']},f.employeeA,'PATCH'),400);
  expect((await f.admin.from('photos').select('tags').eq('id',id).single()).data?.tags).toEqual(['before']);
  const saved=await json(await call(edit,id,{tags:['after']},f.employeeA,'PATCH'));
  expect(saved.photo.tags).toEqual(['after']);expect(saved.photo).not.toHaveProperty('sheet_number');
  expect((await f.sql.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='photos' and column_name='sheet_number'")).rows[0].n).toBe(0);
 });
});
