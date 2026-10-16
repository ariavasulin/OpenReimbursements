#!/usr/bin/env node
// One-off repair for thumbnails and previews stored in the wrong format or
// with the wrong label (finding IMG-1 of the 2026-10 performance audit).
//
// Until the upload client checked what its canvas really produced, iPhones
// (WebKit cannot encode WebP) stored PNG thumbnails (~560 KB) and previews
// (~4.7 MB) under their `.webp` keys, about 15x a WebP. Some other uploads
// stored real WebP labelled `application/octet-stream`. This script finds
// every derived thumbnail/preview whose stored type is not image/webp or
// image/jpeg and rewrites it in place, at the same key:
//   - PNG bytes  -> re-encoded to WebP with sharp, labelled image/webp;
//   - WebP bytes -> the same bytes, labelled image/webp;
//   - JPEG bytes -> the same bytes, labelled image/jpeg;
//   - anything else is reported and left alone.
// It re-encodes the stored derivative itself rather than re-rendering from
// the original: the PNG is already the right size and upright, and this
// works the same for HEIC originals (which sharp cannot read), multi-GB
// originals and video posters, without downloading any original.
//
// Every rewrite carries the one-year cache the uploads now use. Rewriting in
// place is safe: the old files were cached for one hour, and the new file is
// the same picture (the write-once rule on derivedKeys in
// src/lib/photos/repair/sweep.ts). Writes use storage `update`, which fails
// rather than recreating a file that was purged while the script ran.
//
// With --recache it also rewrites correctly typed thumbnails and previews
// that still carry the old one-hour cache (same bytes, new cache header), so
// the whole existing library gets the long cache, not only new uploads.
//
// Idempotent and resumable: a fixed file no longer matches, so a re-run (or
// a run after a crash) picks up only what is left.
//
// Env:   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Usage: node --env-file=.env.local scripts/backfill-png-derivatives.mjs [options]
//   (no flag)        dry run: list and count what would change, write nothing
//   --execute        rewrite the files
//   --recache        also rewrite one-hour-cached files that are otherwise fine
//   --limit N        stop after N files (a small first batch to spot-check)
//   --concurrency N  files in flight at once (default 4)

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BUCKET = 'photos'
const PAGE = 1000
/** Matches DERIVED_CACHE_SECONDS in src/lib/photos/storage-cache.ts. */
export const DERIVED_CACHE_SECONDS = '31536000'
/** sharp's WebP quality, as the server renderer uses (repair/transforms.ts). */
const WEBP_QUALITY = 80
const GOOD_TYPES = new Set(['image/webp', 'image/jpeg'])
const DERIVED_IMAGE = /_(thumb|preview)\.webp$/

export function parseArgs(argv) {
  const opts = { execute: false, recache: false, limit: Infinity, concurrency: 4 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--execute') opts.execute = true
    else if (arg === '--recache') opts.recache = true
    else if (arg === '--limit' || arg === '--concurrency') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} needs a whole number above 0`)
      opts[arg.slice(2)] = value
    } else throw new Error(`Unknown option ${arg}`)
  }
  return opts
}

/** Why a listed object needs rewriting, or null when it does not. */
export function reasonFor(object, { recache }) {
  if (!DERIVED_IMAGE.test(object.name)) return null
  const type = object.metadata?.mimetype ?? null
  if (!GOOD_TYPES.has(type)) return type === 'image/png' ? 'png' : 'mislabelled'
  if (recache && object.metadata?.cacheControl !== `max-age=${DERIVED_CACHE_SECONDS}`) return 'short-cache'
  return null
}

/** The real format, from the first bytes (the stored label may be wrong). */
export function sniff(bytes) {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

/** What to store instead: re-encoded WebP for a PNG, the same bytes with the
 * right label for WebP and JPEG. Null for bytes that are none of these. */
export async function convert(bytes, sharp) {
  const type = sniff(bytes)
  if (type === 'image/png') {
    const body = await sharp(bytes).webp({ quality: WEBP_QUALITY }).toBuffer()
    return { body, contentType: 'image/webp' }
  }
  if (type === 'image/webp' || type === 'image/jpeg') return { body: bytes, contentType: type }
  return null
}

/** Every object under derived/, with its storage metadata. derived/ holds
 * one folder per uploader; list() pages at most 1000 entries at a time. */
async function* listDerived(storage) {
  const page = async (prefix, offset) => {
    const { data, error } = await storage.list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`list ${prefix}: ${error.message}`)
    return data ?? []
  }
  for (let folderOffset = 0; ; folderOffset += PAGE) {
    const folders = await page('derived', folderOffset)
    for (const folder of folders) {
      if (folder.id) continue // a stray file directly under derived/, not a folder
      const prefix = `derived/${folder.name}`
      for (let offset = 0; ; offset += PAGE) {
        const objects = await page(prefix, offset)
        for (const object of objects) {
          if (object.id) yield { ...object, name: `${prefix}/${object.name}` }
        }
        if (objects.length < PAGE) break
      }
    }
    if (folders.length < PAGE) break
  }
}

/** The whole run, with the storage client and sharp passed in so tests can
 * drive it without a network. Returns the counts it also logs. */
export async function run({ storage, sharp, opts, log = console.log }) {
  const counts = {
    listed: 0, candidates: 0, png: 0, mislabelled: 0, shortCache: 0,
    reencoded: 0, relabelled: 0, recached: 0, unknownBytes: 0, errors: 0,
    bytesBefore: 0, bytesAfter: 0,
  }
  const work = []
  for await (const object of listDerived(storage)) {
    counts.listed++
    const reason = reasonFor(object, opts)
    if (!reason) continue
    counts.candidates++
    if (reason === 'png') counts.png++
    else if (reason === 'mislabelled') counts.mislabelled++
    else counts.shortCache++
    if (work.length < opts.limit) work.push({ object, reason })
  }
  log(`listed ${counts.listed} derived files; ${counts.candidates} to fix `
    + `(${counts.png} PNG, ${counts.mislabelled} mislabelled, ${counts.shortCache} short cache)`
    + (work.length < counts.candidates ? `; this run takes the first ${work.length}` : ''))

  const fix = async ({ object, reason }) => {
    const before = object.metadata?.size ?? 0
    if (!opts.execute) {
      log(`would fix ${object.name} (${reason}, ${object.metadata?.mimetype ?? 'no type'}, ${before} bytes)`)
      return
    }
    try {
      const { data, error } = await storage.download(object.name)
      if (error) throw new Error(`download: ${error.message}`)
      const bytes = Buffer.from(await data.arrayBuffer())
      const converted = await convert(bytes, sharp)
      if (!converted) {
        counts.unknownBytes++
        log(`left ${object.name}: its bytes are not PNG, WebP or JPEG`)
        return
      }
      const { error: writeError } = await storage.update(object.name, converted.body, {
        contentType: converted.contentType, cacheControl: DERIVED_CACHE_SECONDS,
      })
      if (writeError) throw new Error(`update: ${writeError.message}`)
      if (sniff(bytes) === 'image/png') counts.reencoded++
      else if (reason === 'short-cache') counts.recached++
      else counts.relabelled++
      counts.bytesBefore += bytes.length
      counts.bytesAfter += converted.body.length
      log(`fixed ${object.name}: ${bytes.length} -> ${converted.body.length} bytes as ${converted.contentType}`)
    } catch (error) {
      counts.errors++
      log(`error ${object.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let next = 0
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, work.length) }, async () => {
    while (next < work.length) await fix(work[next++])
  }))

  log(opts.execute
    ? `done: ${counts.reencoded} re-encoded PNG, ${counts.relabelled} relabelled, ${counts.recached} re-cached, `
      + `${counts.unknownBytes} unknown bytes left alone, ${counts.errors} errors; `
      + `${counts.bytesBefore} -> ${counts.bytesAfter} bytes`
    : 'dry run: nothing was written. Re-run with --execute to fix these files.')
  return counts
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv)
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.')
  const { createClient } = await import('@supabase/supabase-js')
  const { default: sharp } = await import('sharp')
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const counts = await run({ storage: admin.storage.from(BUCKET), sharp, opts })
  return counts.errors === 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(ok => { process.exitCode = ok ? 0 : 1 }, error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
