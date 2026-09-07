import { createHash } from 'node:crypto';
import type { createFixtures } from '../fixtures';

// Stable synthetic photo/job IDs and source metadata make every rehearsal
// reproducible. Auth actors remain the real disposable stack's SMS users.
export const fixtureId = (n: number) => `70000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const fixtureDigest = (n: number) => createHash('sha256').update(`cutover-fixture-${n}`).digest('hex');
export const GROUPS = 102;
export const NULL_HASHES = 3;
export const JOB_A = fixtureId(1);
export const JOB_B = fixtureId(2);
export const INACTIVE_JOB = fixtureId(5);
export const PENDING_ATTEMPT = fixtureId(3);
export const PENDING_PHOTO = fixtureId(4);

export async function seedCutoverFixture(f: Awaited<ReturnType<typeof createFixtures>>) {
  await f.sql.query(`insert into public.jobs(id,job_number,name) values
    ($1,'cutover-fixture-a','Cutover fixture A'),($2,'cutover-fixture-b','Cutover fixture B')`, [JOB_A, JOB_B]);
  await f.sql.query("insert into public.jobs(id,job_number,name,is_active) values($1,'cutover-fixture-inactive','Historical inactive job',false)", [INACTIVE_JOB]);
  const photos = [];
  for (let group = 0; group < GROUPS; group++) {
    for (let member = 0; member < 2; member++) {
      const id = fixtureId(100 + group * 2 + member);
      photos.push({ id, job_id: member ? JOB_B : group === 0 ? INACTIVE_JOB : JOB_A, uploader_id: f.employeeA.id,
        kind: 'image', original_name: `photo-${group}.jpg`, original_bytes: 4,
        original_path: `originals/${f.employeeA.id}/${id}/photo-${group}.jpg`,
        // Both rows in every fifth group deliberately refer to one derivative.
        thumb_path: `derived/${f.employeeA.id}/${fixtureId(100 + group * 2 + (group % 5 ? member : 0))}_thumb.webp`,
        captured_at: '2025-01-01T12:00:00.000Z', created_at: '2025-01-02T12:00:00.000Z',
        tags: [member ? 'legacy-noncanonical-only' : 'canonical-visible'], content_sha256: fixtureDigest(group),
      });
    }
  }
  for (let n = 0; n < NULL_HASHES; n++) {
    const id = fixtureId(1000 + n);
    photos.push({ id, job_id: JOB_A, uploader_id: f.employeeA.id, kind: 'image',
      original_name: `legacy-null-${n}.jpg`, original_bytes: 4,
      original_path: `originals/${f.employeeA.id}/${id}/legacy-null-${n}.jpg`,
      thumb_path: `derived/${f.employeeA.id}/${id}_thumb.webp`,
      captured_at: '2025-01-01T12:00:00.000Z', created_at: '2025-01-02T12:00:00.000Z',
      tags: ['canonical-visible'], content_sha256: null,
    });
  }
  const seeded = await f.admin.from('photos').insert(photos);
  if (seeded.error) throw seeded.error;
  const retainedObjects = [photos[0].original_path, photos[0].thumb_path];
  for (const path of retainedObjects) {
    const uploaded = await f.admin.storage.from('photos').upload(path, Buffer.from([5, 6, 7, 8]), { contentType: 'image/jpeg' });
    if (uploaded.error) throw uploaded.error;
  }
  // A tab that closed with an expired lease still owns its fully transferred
  // original. The cutover must preserve this resumable attempt and object.
  await f.sql.query('update public.photo_release_state set photo_writes_enabled=true where singleton');
  const attempt = await f.admin.rpc('photo_create_upload_attempt', {
    p_actor: f.employeeA.id, p_job_id: JOB_A, p_source_signature: 'closed-tab-source',
    p_digest: fixtureDigest(10000), p_original_name: 'interrupted.jpg', p_original_bytes: 4,
    p_mime_type: 'image/jpeg', p_attempt_id: PENDING_ATTEMPT, p_photo_id: PENDING_PHOTO,
  });
  if (attempt.error) throw attempt.error;
  const originalPath = attempt.data.original_path as string;
  const object = await f.admin.storage.from('photos').upload(originalPath, Buffer.from([1, 2, 3, 4]), { contentType: 'image/jpeg' });
  if (object.error) throw object.error;
  await f.sql.query("update public.photo_upload_attempts set status='uploading',lease_generation=1,lease_expires_at=clock_timestamp()-interval '1 minute' where id=$1", [PENDING_ATTEMPT]);
  await f.sql.query('update public.photo_release_state set photo_writes_enabled=false,mcp_enabled=false,repair_enabled=false where singleton');
  return { photos, originalPath, retainedObjects };
}
