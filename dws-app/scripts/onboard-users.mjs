#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function parseArgs(argv) {
  const args = { execute: false, csv: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--execute' || a === '-x') args.execute = true
    else if (a === '--csv') args.csv = argv[++i]
  }
  return args
}

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

function toE164Plus(phone) {
  const digits = digitsOnly(phone)
  if (!digits) return ''
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
  // fallback: prefix + if missing
  return digits.startsWith('+') ? digits : '+' + digits
}

function buildFullName(last, first) {
  const l = (last || '').trim()
  const f = (first || '').trim()
  if (!l && !f) return ''
  if (!l) return f
  if (!f) return l
  return `${l}, ${f}`
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
  // Map by digits-only phone
  const phoneToUser = new Map()
  for (const u of users) {
    const d = digitsOnly(u.phone)
    if (d) phoneToUser.set(d, u)
  }
  return { users, phoneToUser }
}

async function main() {
  const args = parseArgs(process.argv)
  const root = path.resolve(__dirname, '..', '..')
  const csvPath = path.resolve(args.csv || path.join(root, 'joined_employees.csv'))

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  const rows = readCSV(csvPath)
  const { phoneToUser } = await fetchAllUsersAdmin(supabase)

  const report = {
    execute: args.execute,
    totalRows: rows.length,
    toCreate: 0,
    toUpdateProfiles: 0,
    created: [],
    updatedProfiles: [],
    skippedMissingPhone: [],
    errors: []
  }

  for (const r of rows) {
    try {
      const first = r['First Name'] || ''
      const last = r['Last Name'] || ''
      const employeeId = r['Employee #'] || ''
      const preferred = r['Preferred Name'] || ''
      const mobileRaw = r['Mobile Phone'] || ''

      const mobileDigits = digitsOnly(mobileRaw)
      if (!mobileDigits) {
        report.skippedMissingPhone.push({ first, last, employeeId })
        continue
      }

      const phonePlus = toE164Plus(mobileRaw)
      const phoneKey = mobileDigits // for matching existing users
      const fullName = buildFullName(last, first)

      const existing = phoneToUser.get(phoneKey)
      let userId = existing?.id

      if (!existing) {
        if (!args.execute) {
          report.toCreate += 1
          report.created.push({ phone: phonePlus, full_name: fullName, preferred_name: preferred, employee_id_internal: employeeId, planned: true })
        } else {
          const { data, error } = await supabase.auth.admin.createUser({
            phone: phonePlus,
            phone_confirm: true,
            user_metadata: {
              full_name: fullName,
              preferred_name: preferred,
              employee_id_internal: employeeId,
            },
          })
          if (error) throw error
          userId = data.user?.id
          report.created.push({ user_id: userId, phone: phonePlus })
        }
      }

      if (args.execute && userId) {
        // Update or insert user_profiles
        const profilePayload = {
          role: 'employee',
          full_name: fullName,
          preferred_name: preferred || null,
          employee_id_internal: employeeId || null,
        }

        const { data: upd, error: updErr } = await supabase
          .from('user_profiles')
          .update(profilePayload)
          .eq('user_id', userId)
          .select('user_id')

        if (updErr) throw updErr

        if (!upd || upd.length === 0) {
          const { data: ins, error: insErr } = await supabase
            .from('user_profiles')
            .insert({ user_id: userId, ...profilePayload })
            .select('user_id')
          if (insErr) throw insErr
        }
        report.toUpdateProfiles += 1
        report.updatedProfiles.push({ user_id: userId, full_name: fullName, preferred_name: preferred, employee_id_internal: employeeId })
      }
    } catch (e) {
      report.errors.push({ row: r, error: String(e?.message || e) })
    }
  }

  const outPath = path.join(root, args.execute ? 'onboard_report.json' : 'onboard_dry_run.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`${args.execute ? 'EXECUTION' : 'DRY RUN'} complete. Report written to: ${outPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})


