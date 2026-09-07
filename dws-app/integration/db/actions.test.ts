import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtures } from '../fixtures';

describe('confirmed action transactions (AC-7, AC-8, AC-9)',()=>{
 let f:Awaited<ReturnType<typeof createFixtures>>;
 beforeAll(async()=>{f=await createFixtures();expect((await f.admin.from('photo_release_state').update({photo_writes_enabled:true,mcp_enabled:true}).eq('singleton',true)).error).toBeNull()});
 afterAll(async()=>{await f?.close()});
 async function job(){const id=randomUUID();expect((await f.admin.from('jobs').insert({id,job_number:`db-actions-${id}`,name:'Action database fixture'})).error).toBeNull();return id}
 async function photo(jobId:string){const id=randomUUID();expect((await f.admin.from('photos').insert({id,job_id:jobId,uploader_id:f.employeeA.id,kind:'image',captured_at:new Date().toISOString(),original_path:`originals/${f.employeeA.id}/${id}/fixture.jpg`})).error).toBeNull();return id}
 async function batch(actor:string,action:string,id:string,destination?:string,origin=action==='move'?'ui':'ordinary'){
  const inserted=await f.admin.from('photo_action_batches').insert({created_by:actor,origin,action,selector:{photos:[{photo_id:id}]},destination_job_id:destination??null}).select('id').single();expect(inserted.error).toBeNull();return inserted.data!.id as string;
 }
 async function materialize(actor:string,batch:string,id:string){return f.admin.rpc('photo_materialize_action',{p_actor:actor,p_batch_id:batch,p_cursor:null,p_ids:[id],p_next_cursor:'1',p_complete:true})}
 async function confirm(actor:string,batch:string,id:string){expect((await materialize(actor,batch,id)).error).toBeNull();expect((await f.admin.rpc('photo_approve_action',{p_actor:actor,p_batch_id:batch})).error).toBeNull()}
 const execute=(actor:string,batch:string,id:string)=>f.admin.rpc('photo_execute_action',{p_actor:actor,p_batch_id:batch,p_photo_ids:[id]});
 it('enforces ordinary uploader/admin authority and independently proves MCP bound removal',async()=>{
  const j=await job();
  for(const actor of [f.employeeA,f.administrator]){const id=await photo(j),b=await batch(actor.id,'trash',id);await confirm(actor.id,b,id);const result=await execute(actor.id,b,id);expect(result.error).toBeNull();expect(result.data[0].status).toBe('applied')}
  const id=await photo(j),denied=await batch(f.employeeB.id,'trash',id);expect((await materialize(f.employeeB.id,denied,id)).error?.message).toBe('forbidden');
  const digest=randomBytes(32).toString('hex');expect((await f.admin.from('dws_action_handoffs').insert({token_digest:digest,script_name:'remove_photos',requested_input:{selector:{photos:[{photo_id:id}]}},expires_at:new Date(Date.now()+60_000).toISOString()})).error).toBeNull();
  const consumed=await f.admin.rpc('consume_dws_handoff',{p_actor:f.employeeB.id,p_token_digest:digest,p_script:'remove_photos'});expect(consumed.error).toBeNull();const mcp=consumed.data.photo_action_batch_id;
  await confirm(f.employeeB.id,mcp,id);expect((await execute(f.employeeB.id,mcp,id)).data[0].status).toBe('applied');
  expect((await f.admin.from('photo_action_batches').insert({created_by:f.employeeB.id,origin:'ui',action:'trash'})).error?.code).toBe('23514');
 });
 it('serializes competing confirmed moves with one conflict and preserves the winning item replay',async()=>{
  const from=await job(),toA=await job(),toB=await job(),id=await photo(from);
  const a=await batch(f.employeeA.id,'move',id,toA),b=await batch(f.employeeB.id,'move',id,toB);
  await confirm(f.employeeA.id,a,id);await confirm(f.employeeB.id,b,id);
  const outcomes=await Promise.all([execute(f.employeeA.id,a,id),execute(f.employeeB.id,b,id)]);expect(outcomes.every(o=>!o.error)).toBe(true);expect(outcomes.map(o=>o.data[0].status).sort()).toEqual(['applied','conflict']);
  const winner=outcomes[0].data[0].status==='applied'?{actor:f.employeeA.id,batch:a,job:toA}:{actor:f.employeeB.id,batch:b,job:toB};
  expect((await execute(winner.actor,winner.batch,id)).data[0].status).toBe('applied');expect((await f.admin.from('photos').select('job_id').eq('id',id).single()).data?.job_id).toBe(winner.job);
 });
 it('recognizes the same result from another confirmation without extending trash retention',async()=>{
  const j=await job(),id=await photo(j),a=await batch(f.employeeA.id,'trash',id),b=await batch(f.administrator.id,'trash',id);
  await confirm(f.employeeA.id,a,id);await confirm(f.administrator.id,b,id);
  expect((await execute(f.employeeA.id,a,id)).data[0].status).toBe('applied');
  const first=(await f.admin.from('photos').select('deleted_at,purge_after,deleted_by').eq('id',id).single()).data;
  expect((await execute(f.administrator.id,b,id)).data[0].status).toBe('applied');
  expect((await f.admin.from('photos').select('deleted_at,purge_after,deleted_by').eq('id',id).single()).data).toEqual(first);
  expect((await f.admin.from('photo_action_batches').update({materialization_complete:false}).eq('id',a)).error?.message).toBe('conflict');
 });
});
