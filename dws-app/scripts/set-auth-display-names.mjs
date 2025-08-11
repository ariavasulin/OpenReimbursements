#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function readCSV(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8')
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) throw new Error('CSV is empty')
  const header = lines[0].split(',').map(h => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim())
    const row = {}
    header.forEach((h, idx) => { row[h] = cols[idx] ?? '' })
    rows.push(row)
  }
  return rows
}

function digitsOnly(phone) {
  return (phone || '').replace(/\D/g, '')
}

async function fetchAllUsersAdmin(supabase) {
  const users = []
  let page = 1
  const perPage = 1000
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw error
    users.push(...(data?.users || []))
    if (!data || data.users.length < perPage) break
    page += 1
  }
  const phoneToUser = new Map()
  for (const u of users) {
    const d = digitsOnly(u.phone)
    if (d) phoneToUser.set(d, u)
  }
  return { users, phoneToUser }
}

async function main() {
  const root = path.resolve(__dirname, '..', '..')
  const csvPath = path.resolve(root, 'joined_employees.csv')

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  const rows = readCSV(csvPath)
  const { phoneToUser } = await fetchAllUsersAdmin(supabase)

  const result = { updated: 0, skippedMissingPhone: 0, notFound: 0, errors: [] }

  for (const r of rows) {
    try {
      const preferred = r['Preferred Name'] || ''
      const mobileRaw = r['Mobile Phone'] || ''
      const digits = digitsOnly(mobileRaw)
      if (!digits) { result.skippedMissingPhone++; continue }
      const user = phoneToUser.get(digits)
      if (!user) { result.notFound++; continue }
      const userId = user.id
      const { error } = await supabase.auth.admin.updateUserById(userId, {
        user_metadata: {
          name: preferred,
          full_name: preferred,
          preferred_name: preferred,
        }
      })
      if (error) throw error
      result.updated++
    } catch (e) {
      result.errors.push(String(e?.message || e))
    }
  }

  const outPath = path.join(root, 'set_display_names_report.json')
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`Done. Report written to: ${outPath}`)
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1) })


