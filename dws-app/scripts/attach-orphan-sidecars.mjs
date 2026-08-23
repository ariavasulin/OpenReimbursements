#!/usr/bin/env node
// One-time repair for .xmp files that uploaded as their own kind='file' rows
// before sidecar pairing existed.
//
// Env:   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Usage: node scripts/attach-orphan-sidecars.mjs            (dry run, default)
//        node scripts/attach-orphan-sidecars.mjs --execute  (apply)

import { createClient } from '@supabase/supabase-js'

const execute = process.argv.includes('--execute') || process.argv.includes('-x')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Mirrors sanitizeFilename in src/lib/photos/upload.ts (base part only), so
// the destination key matches what a fresh upload of this pair would use.
function sanitizeBase(name) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return (
    base
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'file'
  )
}

function basenameLower(name) {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase()
}

async function main() {
  const { data: rows, error } = await supabase
    .from('photos')
    .select('id, job_id, uploader_id, kind, original_name, original_path, sidecar_path')
  if (error) throw new Error(error.message)

  const orphans = rows.filter(
    (r) => r.kind === 'file' && (r.original_name ?? '').toLowerCase().endsWith('.xmp')
  )
  const images = rows.filter((r) => r.kind === 'image')

  const plans = []
  const unmatched = []
  const claimedImages = new Set()
  for (const orphan of orphans) {
    const base = basenameLower(orphan.original_name)
    const candidates = images.filter(
      (image) =>
        image.uploader_id === orphan.uploader_id &&
        image.job_id === orphan.job_id &&
        basenameLower(image.original_name ?? '') === base
    )
    if (candidates.length !== 1) {
      unmatched.push({ orphan, why: `${candidates.length} candidate images` })
      continue
    }
    const image = candidates[0]
    if (image.sidecar_path) {
      unmatched.push({ orphan, why: `image ${image.id} already has a sidecar` })
      continue
    }
    if (claimedImages.has(image.id)) {
      unmatched.push({ orphan, why: `image ${image.id} claimed by another orphan` })
      continue
    }
    claimedImages.add(image.id)
    const dest = `originals/${image.uploader_id}/${image.id}/${sanitizeBase(orphan.original_name)}.xmp`
    plans.push({ orphan, image, dest })
  }

  console.log(
    `${orphans.length} orphan .xmp row(s): ${plans.length} matched, ${unmatched.length} unmatched`
  )
  for (const p of plans) {
    console.log(
      `  ATTACH ${p.orphan.original_name}: move ${p.orphan.original_path} -> ${p.dest}; ` +
        `set sidecar on image ${p.image.id}; delete row ${p.orphan.id}`
    )
  }
  for (const u of unmatched) {
    console.log(`  UNMATCHED ${u.orphan.original_name} (row ${u.orphan.id}): ${u.why}`)
  }

  if (!execute) {
    console.log('Dry run — pass --execute to apply.')
    return
  }

  let attached = 0
  const errors = []
  for (const p of plans) {
    try {
      const { error: moveError } = await supabase.storage
        .from('photos')
        .move(p.orphan.original_path, p.dest)
      if (moveError) throw new Error(`move: ${moveError.message}`)

      const { error: updateError } = await supabase
        .from('photos')
        .update({ sidecar_path: p.dest, sidecar_name: p.orphan.original_name })
        .eq('id', p.image.id)
      if (updateError) throw new Error(`update image: ${updateError.message}`)

      const { error: deleteError } = await supabase
        .from('photos')
        .delete()
        .eq('id', p.orphan.id)
      if (deleteError) throw new Error(`delete orphan row: ${deleteError.message}`)

      attached += 1
    } catch (e) {
      errors.push(`${p.orphan.original_name}: ${e.message}`)
    }
  }

  console.log(JSON.stringify({ attached, unmatched: unmatched.length, errors }, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
