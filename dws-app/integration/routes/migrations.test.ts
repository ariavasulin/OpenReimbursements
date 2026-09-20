import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtures } from '../fixtures';
import { withRequest } from './request-context';
vi.mock('next/headers', async () => {
  const { requestContext } = await import('./request-context');
  return { cookies: async () => ({ get: (name: string) => {
    const value = requestContext.getStore()!.cookies.get(name); return value === undefined ? undefined : { name, value };
  }, set: (name: string, value: string) => { requestContext.getStore()!.cookies.set(name, value); } }),
  headers: async () => requestContext.getStore()!.headers };
});
import { POST as create, GET as recent } from '@/app/api/photo-migrations/batches/route';
import { PATCH as action, GET as detail } from '@/app/api/photo-migrations/batches/[id]/route';
import { POST as source } from '@/app/api/photo-migrations/batches/[id]/sources/route';
import { POST as scan } from '@/app/api/photo-migrations/sources/[id]/scan/route';
import { POST as chunk } from '@/app/api/photo-migrations/sources/[id]/chunks/route';
import { POST as seal } from '@/app/api/photo-migrations/sources/[id]/seal/route';
import { GET as items } from '@/app/api/photo-migrations/batches/[id]/items/route';
import { POST as itemAction } from '@/app/api/photo-migrations/items/[id]/route';
import { POST as consume } from '@/app/api/photo-migrations/handoffs/consume/route';
import { GET as jobs } from '@/app/api/photo-migrations/jobs/route';
import { POST as prepare } from '@/app/api/photo-migrations/uploads/prepare/route';

describe('migration route ingestion and review (AC-3, AC-4)', () => {
 let f: Awaited<ReturnType<typeof createFixtures>>;
 const jobId=randomUUID();
 beforeAll(async()=>{
  f=await createFixtures();
  expect((await f.admin.from('photo_release_state').upsert({singleton:true,schema_generation:1,photo_writes_enabled:true,mcp_enabled:true,repair_enabled:true})).error).toBeNull();
  expect((await f.admin.from('jobs').insert({id:jobId,job_number:`migration-routes-${jobId}`,name:'Migration route fixture'})).error).toBeNull();
 });
 afterAll(async()=>{await f?.close();});
 type Handler=(r:Request,c:{params:Promise<{id:string}>})=>Promise<Response>;
 async function invoke(handler:Handler, id:string, body?:unknown, actor=f.employeeA, method=body===undefined?'GET':'POST', query='') {
  const r=new Request(`http://localhost:3000/api/photo-migrations/test${query}`,{method,headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return withRequest(r,actor.cookies,()=>handler(r,{params:Promise.resolve({id})}));
 }
 async function ok(handler:Handler,id:string,body?:unknown,method?:string,query='') {
  const r=await invoke(handler,id,body,f.employeeA,method,query);const value=await r.json();expect(r.status,JSON.stringify(value)).toBe(200);return value;
 }
 async function start(){
  const batch=(await ok(create,'',{script_name:'migrate_photos'})).batch;
  const s=(await ok(source,batch.id,{job_id:jobId,kind:'directory',label:'Directory'})).source;
  const scanId=randomUUID();await ok(scan,s.id,{scan_id:scanId});return {batch,s,scanId};
 }
 const entry=(n:number)=>({relative_path:`folder/${n}.jpg`,original_name:`${n}.jpg`,original_bytes:1048577,source_mtime:1,mime_type:'image/jpeg',source_signature:`${n}:1048577:1`});
 async function finish(v:Awaited<ReturnType<typeof start>>, records:Array<{payload_digest:string;entry_count:number;total_bytes:number}>) {
  return ok(seal,v.s.id,{scan_id:v.scanId,chunk_count:records.length,total_entries:records.reduce((n,c)=>n+c.entry_count,0),
   total_bytes:records.reduce((n,c)=>n+c.total_bytes,0),job_id:jobId,fingerprint:createHash('sha256').update(records.map(c=>c.payload_digest).join('')).digest('hex')});
 }
 it('job search preserves literal percent, underscore and backslash characters',async()=>{
  const prefix=randomUUID();
  const numbers=[`${prefix}%`,`${prefix}_`,`${prefix}\\`,`${prefix}plain`];
  expect((await f.admin.from('jobs').insert(numbers.map(job_number=>({job_number,name:'Literal search'})))).error).toBeNull();
  for(const number of numbers.slice(0,3)) {
   const result=await ok(jobs,'',undefined,'GET',`?q=${encodeURIComponent(number)}`);
   expect(result.jobs.map((job:{job_number:string})=>job.job_number)).toEqual([number]);
  }
 });
 it('accepts exactly 500 entries; same chunk replays and changed payload conflicts',async()=>{
  const v=await start();const body={scan_id:v.scanId,chunk_number:0,entries:Array.from({length:500},(_,i)=>entry(i))};
  const first=await ok(chunk,v.s.id,body);expect(first).toMatchObject({replayed:false,entry_count:500,total_bytes:500*1048577});
  expect(await ok(chunk,v.s.id,body)).toEqual({...first,replayed:true});
  expect((await invoke(chunk,v.s.id,{...body,entries:[entry(999)]})).status).toBe(409);
  expect((await invoke(chunk,v.s.id,{...body,chunk_number:1,entries:Array.from({length:501},(_,i)=>entry(i+500))})).status).toBe(400);
  await finish(v,[first]);
  const page=await ok(items,v.batch.id,undefined,'GET','?limit=37');expect(page.items).toHaveLength(37);expect(page.next_cursor).toEqual(expect.any(String));
  const next=await ok(items,v.batch.id,undefined,'GET',`?limit=37&after=${page.next_cursor}`);expect(next.items).toHaveLength(37);
  expect(next.items.some((x:{id:string})=>page.items.some((y:{id:string})=>y.id===x.id))).toBe(false);
  expect((await ok(detail,v.batch.id)).counts).toMatchObject({total:500,total_bytes:500*1048577,by_status:{pending:500}});
 });
 it('bounds actual streamed UTF-8 bytes at 1MiB including envelope without Content-Length',async()=>{
  const v=await start();const base={scan_id:v.scanId,chunk_number:0,entries:[entry(1)],padding:''};
  const initial=JSON.stringify(base);base.padding=' '.repeat(1048576-Buffer.byteLength(initial));
  const exact=JSON.stringify(base);expect(Buffer.byteLength(exact)).toBe(1048576);
  expect((await invoke(chunk,v.s.id,base)).status).toBe(200);
  const oversized=JSON.stringify({...base,padding:base.padding+'é'});
  const bytes=new TextEncoder().encode(oversized);
  const stream=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=16384)controller.enqueue(bytes.slice(i,i+16384));controller.close();}});
  const request=new Request('http://localhost:3000/api/photo-migrations/test',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:3000'},body:stream,duplex:'half'} as RequestInit);
  expect(request.headers.has('content-length')).toBe(false);
  const response=await withRequest(request,f.employeeA.cookies,()=>chunk(request,{params:Promise.resolve({id:v.s.id})}));expect(response.status).toBe(413);
 });
 it('rejects unknown/inactive jobs and source approval before seal',async()=>{
  const v=await start();
  expect((await invoke(source,v.batch.id,{job_id:randomUUID(),kind:'directory',label:'Unknown'})).status).toBe(400);
  expect((await invoke(action,v.batch.id,{action:'approve'},f.employeeA,'PATCH')).status).toBe(409);
  const first=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(1)]});
  expect((await invoke(action,v.batch.id,{action:'approve'},f.employeeA,'PATCH')).status).toBe(409);
  await finish(v,[first]);expect((await ok(action,v.batch.id,{action:'approve'},'PATCH')).batch.status).toBe('approved');
 });
 it('missing chunk, incorrect totals/digests or changed job deny seal with no visible staged items',async()=>{
  const v=await start();const record=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:1,entries:[entry(1)]});
  const valid={scan_id:v.scanId,chunk_count:1,total_entries:1,total_bytes:1048577,job_id:jobId,fingerprint:createHash('sha256').update(record.payload_digest).digest('hex')};
  expect((await invoke(seal,v.s.id,valid)).status).toBe(409);
  expect((await ok(items,v.batch.id)).items).toEqual([]);
  const zero=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(0)]});
  const complete={...valid,chunk_count:2,total_entries:2,total_bytes:2*1048577,fingerprint:createHash('sha256').update(zero.payload_digest+record.payload_digest).digest('hex')};
  for(const patch of [{total_entries:3},{total_bytes:1},{fingerprint:'a'.repeat(64)},{job_id:randomUUID()}])expect((await invoke(seal,v.s.id,{...complete,...patch})).status).toBe(409);
  await ok(seal,v.s.id,complete);expect((await ok(items,v.batch.id)).items).toHaveLength(2);
 });
 it('other employees inspect progress but cannot approve, ingest or prepare owned work',async()=>{
  const v=await start();const record=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(0)]});await finish(v,[record]);
  const read=await invoke(detail,v.batch.id,undefined,f.employeeB);expect(read.status).toBe(200);expect((await read.json()).can_mutate).toBe(false);
  expect((await invoke(action,v.batch.id,{action:'approve'},f.employeeB,'PATCH')).status).toBe(403);
  expect((await invoke(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(0)]},f.employeeB)).status).toBe(403);
  await ok(action,v.batch.id,{action:'approve'},'PATCH');const item=(await ok(items,v.batch.id)).items[0];
  expect((await invoke(prepare,'',{item_id:item.id,revision:1,source_signature:item.source_signature,content_sha256:'a'.repeat(64)},f.employeeB)).status).toBe(403);
 });
 it('prepare binds deterministic migration identity and denies stale source signature/digest',async()=>{
  const v=await start();const record=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(0)]});await finish(v,[record]);await ok(action,v.batch.id,{action:'approve'},'PATCH');
  const item=(await ok(items,v.batch.id)).items[0];const body={item_id:item.id,revision:item.revision,source_signature:item.source_signature,content_sha256:'b'.repeat(64)};
  const attempt=await ok(prepare,'',body);expect(attempt).toMatchObject({owner_kind:'migration',owner_id:item.id,photo_id:item.photo_id,job_id:jobId,result:null});
  expect(attempt.original_path).toBe(`originals/${f.employeeA.id}/${item.photo_id}/0.jpg`);
  expect(await ok(prepare,'',body)).toEqual(attempt);
  for(const patch of [{revision:2},{source_signature:'changed'},{content_sha256:'c'.repeat(64)}])expect((await invoke(prepare,'',{...body,...patch})).status).toBe(409);
 });
 it('recent batches are shared bounded reads with no mutation authority borrowed',async()=>{
  const v=await start();const result=await ok(recent,'',undefined,'GET','?limit=2');expect(result.batches).toHaveLength(2);expect(result.next_cursor).toEqual(expect.any(String));
  const second=await ok(recent,'',undefined,'GET',`?limit=2&after=${encodeURIComponent(result.next_cursor)}`);expect(second.batches.some((x:{id:string})=>result.batches.some((y:{id:string})=>x.id===y.id))).toBe(false);
  expect((await ok(detail,v.batch.id)).batch.script_name).toBe('migrate_photos');
 });
 it('persists retry timing and fresh-attempt need with generation fencing and explicit recovery',async()=>{
  const v=await start();const record=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[entry(0)]});await finish(v,[record]);await ok(action,v.batch.id,{action:'approve'},'PATCH');
  const item=(await ok(items,v.batch.id)).items[0];const due=new Date(Date.now()+2*86400000).toISOString();
  const body={action:'outcome',lease_generation:0,retry_after:due,retryable:false,new_attempt_required:true,error_code:'original_path_occupied',warnings:['Retained original path needs a fresh attempt.']};
  expect((await invoke(itemAction,item.id,{...body,lease_generation:1})).status).toBe(409);
  const saved=(await ok(itemAction,item.id,body)).item;expect(saved).toMatchObject({retryable:false,new_attempt_required:true,retry_count:1});expect(Date.parse(saved.retry_after)).toBe(Date.parse(due));
  expect((await invoke(prepare,'',{item_id:item.id,revision:1,source_signature:item.source_signature,content_sha256:'b'.repeat(64)})).status).toBe(409);
  const replacement=(await ok(itemAction,item.id,{action:'retry'})).item;expect(replacement.id).not.toBe(item.id);expect(replacement.revision).toBe(2);expect(replacement.photo_id).not.toBe(item.photo_id);
  expect((await invoke(itemAction,item.id,body)).status).toBe(409);
  const prepared=await ok(prepare,'',{item_id:replacement.id,revision:2,source_signature:item.source_signature,content_sha256:'b'.repeat(64)});
  const lease=await f.admin.rpc('photo_acquire_upload',{p_actor:f.employeeA.id,p_owner_kind:'migration',p_owner_id:prepared.owner_id});expect(lease.error).toBeNull();
  expect((await invoke(itemAction,replacement.id,{...body,lease_generation:lease.data.lease_generation})).status).toBe(409);
 });
 it('resumed handoff exposes planning hints only to its bound consumer',async()=>{
  const token=Buffer.from(randomUUID()+randomUUID()).subarray(0,32).toString('base64url');
  const hints={sources:[{label:'Archive',job_number:'1234'}],tags:['site'],sheet_number:'A-1'};
  expect((await f.admin.from('dws_action_handoffs').insert({token_digest:createHash('sha256').update(token).digest('hex'),script_name:'migrate_photos',requested_input:hints,expires_at:new Date(Date.now()+60000).toISOString()})).error).toBeNull();
  const bound=await ok(consume,'',{token,script_name:'migrate_photos'});
  expect((await ok(detail,bound.migration_batch_id)).batch.requested_input).toEqual(hints);
  const response=await invoke(detail,bound.migration_batch_id,undefined,f.employeeB);expect((await response.json()).batch.requested_input).toEqual({});
 });

 it('review reports paired XMP bytes separately and includes them in upload totals',async()=>{
  const v=await start();const media={...entry(0),sidecar:{relative_path:'folder/0.xmp',original_name:'0.xmp',original_bytes:321,source_mtime:1,mime_type:'application/rdf+xml',source_signature:'sidecar:321:1'}};
  const record=await ok(chunk,v.s.id,{scan_id:v.scanId,chunk_number:0,entries:[media]});await finish(v,[record]);
  expect((await ok(detail,v.batch.id)).counts).toMatchObject({total:1,total_bytes:1048577,media_bytes:1048577,sidecar_bytes:321,upload_bytes:1048898,xmp:1});
 });

});
