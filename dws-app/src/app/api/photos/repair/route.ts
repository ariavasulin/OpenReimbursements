import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { WorkBudget } from '@/lib/photos/repair/deadline';
import { emptyReport, runRepair } from '@/lib/photos/repair/run';

export const maxDuration = 300;

/** Buffer small control responses within the timeout too: fetch alone resolves
 * at headers, leaving a stalled JSON body otherwise outside cancellation. */
function client(budget: WorkBudget, operationMs = 15_000) {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => budget.run(async signal => {
      const response = await fetch(input, { ...init, signal });
      const parts: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 4 * 1024 * 1024) throw new Error('repair control response exceeds 4 MiB');
            parts.push(next.value);
          }
        } finally { await reader.cancel(); }
      }
      const body = response.body ? Buffer.concat(parts, size) : null;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }, AbortSignal.any([AbortSignal.timeout(operationMs), ...(init?.signal ? [init.signal] : [])])) },
  });
}

async function run(request: Request) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const budget = new WorkBudget(startedAt);
  const admin = client(budget);
  // Both cron GET and manual POST fail closed before lease/Storage mutation.
  const gate = await admin.from('photo_release_state').select('repair_enabled,schema_generation').eq('singleton', true).maybeSingle();
  if (gate.error || gate.data?.repair_enabled !== true || gate.data?.schema_generation !== 1) {
    return NextResponse.json({ ...emptyReport(), error_count: 1, errors: ['Repair is temporarily unavailable'] }, { status: 503 });
  }
  const raw = new URL(request.url).searchParams.get('olderThan');
  if (raw !== null && (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0)) {
    return NextResponse.json({ error: 'olderThan must be a non-negative number of ms' }, { status: 400 });
  }
  // The extra ten seconds are reserved solely for reporting/releasing work;
  // this client is never passed to inventory, purge, repairs or ffmpeg.
  const cleanup = client(new WorkBudget(startedAt, 250_000), 5_000);
  const { report, status } = await runRepair(admin, budget, { orphanMs: raw === null ? undefined : Number(raw), cleanupAdmin: cleanup });
  console.info('photos.repair', JSON.stringify(report));
  return NextResponse.json(report, { status });
}
export const GET = run;
export const POST = run;
