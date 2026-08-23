// Payroll CSV builder. The payroll system consumes this output — do not change
// its format; payrollCsv.test.ts pins it with a golden fixture, and
// byte-identical output is the contract.
//
// The one deliberate departure from pure quoting: a text cell that starts with
// =, +, - or @ gets a leading apostrophe. Spreadsheets strip CSV quoting before
// deciding whether a cell is a formula, and the employee name comes from
// PATCH /api/profile, where any signed-in user may set it.

const FORMULA_LEADERS = /^[=+\-@]/

// quoteCsv always wraps values in quotes, even when not required.
export function quoteCsv(value: string): string {
  const neutralised = FORMULA_LEADERS.test(value) ? `'${value}` : value
  const escaped = neutralised.replace(/"/g, '""')
  return `"${escaped}"`
}

export type PayrollReceiptRow = {
  employeeId: string
  employeeName: string
  amount: number | string
}

export function buildPayrollCsv(rows: PayrollReceiptRow[]): string {
  const headers = ['LastName', 'FirstName', 'EmployeeNumber', 'TotalAmount']

  const totalsMap = new Map<string, { lastName: string; firstName: string; employeeNumber: string; total: number }>()

  const parseLastFirst = (name?: string): { last: string; first: string } => {
    if (name && name.includes(',')) {
      const [l, f] = name.split(',')
      return { last: (l || '').trim(), first: (f || '').trim() }
    }
    return { last: '', first: (name || '').trim() }
  }

  for (const r of rows) {
    const employeeNumber = r.employeeId || ''
    const { last, first } = parseLastFirst(r.employeeName)
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount) || 0
    const existing = totalsMap.get(employeeNumber)
    if (existing) {
      existing.total += amount
    } else {
      totalsMap.set(employeeNumber, { lastName: last, firstName: first, employeeNumber, total: amount })
    }
  }

  const sorted = Array.from(totalsMap.values()).sort((a, b) => {
    const ln = a.lastName.localeCompare(b.lastName)
    return ln !== 0 ? ln : a.firstName.localeCompare(b.firstName)
  })

  const csvLines = [
    headers.join(','),
    ...sorted.map(r => [
      quoteCsv(r.lastName),
      quoteCsv(r.firstName),
      quoteCsv(r.employeeNumber),
      (Number.isFinite(r.total) ? r.total.toFixed(2) : '0.00'),
    ].join(','))
  ]

  return csvLines.join('\n')
}
