// Faithful reproduction harness for the receipt OCR pipeline.
// Drives the REAL /api/receipts/upload -> /api/receipts/ocr routes (no reimplementation)
// against a given receipt image, capturing the genuine OCR envelope + raw ExtractedReceipt.
//
// Usage:
//   1. cp .env dws-app/.env.local   (Supabase + OpenRouter keys)
//   2. cd dws-app && npm run dev     (or `next dev`) in another shell
//   3. node scripts/reproduce-receipt.mjs <path-to-image.jpg> [outDir]
//
// Auth: mints a real session autonomously via the service-role key (creates a throwaway
// test user, signs in, serializes the @supabase/ssr cookie with the library itself so the
// real route handlers' getUser()/getSession() accept it).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

const BASE = process.env.REPRO_BASE_URL || 'http://localhost:3000';
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = process.env.REPRO_TEST_EMAIL || 'repro-harness@dws-receipts.test';
const TEST_PW = process.env.REPRO_TEST_PW || 'Repro-Harness-Pw-123!';

const imagePath = process.argv[2];
const outDir = process.argv[3] || 'scripts/repro-fixtures/last-run';

function die(msg, extra) {
  console.error('FATAL:', msg);
  if (extra) console.error(extra);
  process.exit(1);
}

if (!imagePath) die('pass an image path as arg 1');
if (!URL || !ANON) die('missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY) — load dws-app/.env.local');

// Load env from dws-app/.env.local if the vars aren't already in process.env.
// (Run via `node --env-file` if your Node supports it; otherwise rely on shell export.)

// The app authenticates via phone SMS OTP. These are the project's configured
// TEST phone numbers (fixed OTP, no SMS sent) — set REPRO_TEST_PHONE/REPRO_TEST_OTP to override.
const PHONE_OTP_CANDIDATES = (process.env.REPRO_TEST_PHONE && process.env.REPRO_TEST_OTP)
  ? [[process.env.REPRO_TEST_PHONE, process.env.REPRO_TEST_OTP]]
  : [['1234567', '1234'], ['7654321', '1234'], ['1234', '1234']];

async function mintSession() {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const errs = [];
  // Try each test number, with and without a leading '+', until one returns a session.
  for (const [rawPhone, token] of PHONE_OTP_CANDIDATES) {
    for (const phone of [rawPhone, rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`]) {
      const v = await anon.auth.verifyOtp({ phone, token, type: 'sms' });
      if (v.data?.session) {
        console.error(`[auth] phone OTP session via ${phone}`);
        return v.data.session;
      }
      errs.push(`${phone}: ${v.error?.message}`);
    }
  }
  die('all phone OTP candidates failed', errs.join('\n'));
}

function buildCookieHeader(session) {
  // Use the ssr server client's own cookie serialization so names/chunking/format
  // match exactly what the real route handlers read back.
  const jar = {};
  const capture = createServerClient(URL, ANON, {
    cookies: {
      getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
      setAll: (list) => { for (const { name, value } of list) jar[name] = value; },
    },
  });
  return capture.auth
    .setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    .then(() => Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; '));
}

async function main() {
  const session = await mintSession();
  const cookie = await buildCookieHeader(session);
  if (!cookie) die('failed to serialize auth cookie');

  // --- Hop 1: real upload route (runs real sharp resize) ---
  const buf = await readFile(imagePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/jpeg' }), basename(imagePath));
  const upRes = await fetch(`${BASE}/api/receipts/upload`, { method: 'POST', headers: { cookie }, body: fd });
  const upJson = await upRes.json().catch(() => ({ _nonJson: true, status: upRes.status }));
  if (!upRes.ok || !upJson.tempFilePath) die(`upload route failed (${upRes.status})`, JSON.stringify(upJson));

  // --- Hop 2: real OCR route (runs real Image.fromBase64 + b.ExtractReceiptFromImage) ---
  const ocrRes = await fetch(`${BASE}/api/receipts/ocr`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ tempFilePath: upJson.tempFilePath }),
  });
  const ocrJson = await ocrRes.json().catch(() => ({ _nonJson: true, status: ocrRes.status }));

  const record = {
    image: imagePath,
    timestamp: new Date().toISOString(),
    upload: upJson,
    ocrStatus: ocrRes.status,
    ocr: ocrJson,
  };

  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `${basename(imagePath).replace(/\.[^.]+$/, '')}.envelope.json`);
  await writeFile(outFile, JSON.stringify(record, null, 2));

  console.log('\n=== OCR ENVELOPE ===');
  console.log(JSON.stringify(ocrJson, null, 2));
  console.log(`\n(Raw ExtractedReceipt is in the dev-server log: grep "[REPRO] RAW EXTRACTED")`);
  console.log(`Saved: ${outFile}`);
}

main().catch((e) => die('unhandled', e?.stack || String(e)));
