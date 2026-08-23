import { describe, expect, it } from 'vitest'
import { normalizeReceiptSearch, receiptMatchesSearch } from './receiptSearch'

describe('normalizeReceiptSearch', () => {
  it('trims and lowercases', () => {
    expect(normalizeReceiptSearch('  Jane DOE ')).toBe('jane doe')
  })

  it('treats null/undefined/blank as no search', () => {
    expect(normalizeReceiptSearch(null)).toBe('')
    expect(normalizeReceiptSearch(undefined)).toBe('')
    expect(normalizeReceiptSearch('   ')).toBe('')
  })
})

describe('receiptMatchesSearch', () => {
  const receipt = { employeeName: 'Jane Doe', description: 'Gas for the truck' }

  it('matches everything when there is no search term', () => {
    expect(receiptMatchesSearch(receipt, '')).toBe(true)
    expect(receiptMatchesSearch({}, '')).toBe(true)
  })

  it('matches on employee name, case-insensitively', () => {
    expect(receiptMatchesSearch(receipt, normalizeReceiptSearch('jane'))).toBe(true)
    expect(receiptMatchesSearch(receipt, normalizeReceiptSearch('DOE'))).toBe(true)
  })

  it('matches on description', () => {
    expect(receiptMatchesSearch(receipt, normalizeReceiptSearch('truck'))).toBe(true)
  })

  it('rejects a term in neither field', () => {
    expect(receiptMatchesSearch(receipt, normalizeReceiptSearch('parking'))).toBe(false)
  })

  it('tolerates missing fields', () => {
    expect(
      receiptMatchesSearch({ employeeName: null, description: null }, 'jane')
    ).toBe(false)
  })
})
