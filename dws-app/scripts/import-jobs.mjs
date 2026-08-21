#!/usr/bin/env node
// One-time import of active jobs from the office DB CSV dumps into public.jobs.
// Joins tblProject (ProjectID, Project, Location, Archived) with
// tblMas90JobMasterOpen (JobNo, JobStatus) on ProjectID = JobNo, keeps open
// un-archived rows, and upserts by job_number with the service-role client.
//
// Usage (env from shell, e.g. `set -a; source .env.local; set +a`):
//   node scripts/import-jobs.mjs --projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv>            # dry run
//   node scripts/import-jobs.mjs --projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv> --execute  # write
//
// NOTE: csv-parse handles tblProject.csv's quoted embedded commas/newlines.
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'

function parseArgs(argv) {
  const args = { execute: false, projects: null, jobs: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--execute' || a === '-x') args.execute = true
    else if (a === '--projects') args.projects = argv[++i]
    else if (a === '--jobs') args.jobs = argv[++i]
  }
  return args
}

function readCSV(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8')
  return parse(text, { columns: true, skip_empty_lines: true, bom: true, trim: true })
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.projects || !args.jobs) {
    console.error('Usage: node scripts/import-jobs.mjs --projects <tblProject.csv> --jobs <tblMas90JobMasterOpen.csv> [--execute]')
    process.exit(1)
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    process.exit(1)
  }

  const projects = readCSV(args.projects)
  const openJobs = readCSV(args.jobs)
  console.log(`tblProject rows: ${projects.length}`)
  console.log(`tblMas90JobMasterOpen rows: ${openJobs.length}`)

  const projectByNumber = new Map()
  for (const p of projects) {
    const key = String(p.ProjectID || '').trim()
    if (key) projectByNumber.set(key, p)
  }

  const rows = []
  const unmatched = []
  let archivedDropped = 0
  const syncedAt = new Date().toISOString()
  for (const j of openJobs) {
    const jobNo = String(j.JobNo || '').trim()
    if (!jobNo) continue
    if (String(j.JobStatus || '').trim() !== 'O') continue // open jobs only
    const p = projectByNumber.get(jobNo)
    if (!p) {
      unmatched.push(jobNo)
      continue
    }
    if (String(p.Archived).trim().toLowerCase() === 'true') {
      archivedDropped += 1
      continue
    }
    rows.push({
      job_number: jobNo,
      name: String(p.Project || '').trim(),
      location: String(p.Location || '').trim() || null,
      is_active: true,
      synced_at: syncedAt,
    })
  }

  console.log(`Joined open + un-archived jobs to import: ${rows.length}`)
  if (archivedDropped) console.log(`Dropped (archived in tblProject): ${archivedDropped}`)
  if (unmatched.length) {
    console.warn(`WARNING: ${unmatched.length} open JobNo(s) have NO tblProject row and are NOT imported: ${unmatched.join(', ')}`)
  }

  if (!args.execute) {
    console.log('DRY RUN — no writes. Rows that would be upserted:')
    for (const r of rows) console.log(`  ${r.job_number}  ${r.name}  (${r.location ?? 'no location'})`)
    console.log('Re-run with --execute to write.')
    return
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await supabase
    .from('jobs')
    .upsert(rows, { onConflict: 'job_number' })
    .select('job_number')
  if (error) {
    console.error('Upsert failed:', error.message)
    process.exit(1)
  }
  console.log(`Upserted ${data.length} rows into public.jobs.`)

  const { count, error: countErr } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
  if (countErr) {
    console.error('Count check failed:', countErr.message)
    process.exit(1)
  }
  console.log(`public.jobs now holds ${count} rows total.`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
