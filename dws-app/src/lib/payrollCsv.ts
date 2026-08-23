// Payroll CSV builder, moved verbatim from the inline implementation in
// components/receipt-dashboard.tsx (quoteCsv + the downloadPayrollCSV
// aggregation body). The payroll system consumes this output — do not change
// its format. payrollCsv.test.ts holds a golden fixture captured from the
// pre-refactor code; byte-identical output is the contract.

// The original always wraps values in quotes (it does not quote
// conditionally); preserved exactly.
export function quoteCsv(value: string): string {
  const escaped = value.replace(/"/g, '""')
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
    const key = employeeNumber
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount) || 0
    const existing = totalsMap.get(key)
    if (existing) {
      existing.total += amount
    } else {
      totalsMap.set(key, { lastName: last, firstName: first, employeeNumber, total: amount })
    }
  }

  const sorted = Array.from(totalsMap.values()).sort((a, b) => {
    const ln = a.lastName.localeCompare(b.lastName)
    return ln !== 0 ? ln : a.firstName.localeCompare(b.firstName)
  })

  const csvLines = [
    headers.join(','),
    ...sorted.map(r => [
      quoteCsv(r.lastName || ''),
      quoteCsv(r.firstName || ''),
      quoteCsv(r.employeeNumber || ''),
      (Number.isFinite(r.total) ? r.total.toFixed(2) : '0.00'),
    ].join(','))
  ]

  return csvLines.join('\n')
}
