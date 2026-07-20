import { describe, it, expect } from 'vitest'
import {
  formatCreatedAt,
  formatTimestamp,
  isWithinRelativeCreatedAtWindow,
  isWithinRelativeTimestampWindow,
  parseApiDate,
} from '@/utils/dates'

describe('parseApiDate', () => {
  it('parses UTC timestamps with Z suffix', () => {
    expect(parseApiDate('2024-01-01T00:00:00Z').toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('treats timestamps without timezone as UTC', () => {
    expect(parseApiDate('2024-01-01T00:00:00').toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })
})

describe('formatTimestamp', () => {
  const now = new Date('2024-06-01T12:00:00Z')

  it('shows minutes ago for recent items', () => {
    const createdAt = '2024-06-01T11:45:00Z'
    expect(formatTimestamp(createdAt, now)).toBe('15m ago')
    expect(formatCreatedAt(createdAt, now)).toBe('15m ago')
  })

  it('shows hours and minutes ago within 12 hours', () => {
    const createdAt = '2024-06-01T09:30:00Z'
    expect(formatTimestamp(createdAt, now)).toBe('2h 30m ago')
  })

  it('shows just now for items under one minute old', () => {
    const createdAt = '2024-06-01T11:59:30Z'
    expect(formatTimestamp(createdAt, now)).toBe('just now')
  })

  it('shows absolute date and time after 12 hours', () => {
    const createdAt = '2024-05-31T12:00:00Z'
    const expected = parseApiDate(createdAt).toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
    expect(formatTimestamp(createdAt, now)).toBe(expected)
    expect(formatTimestamp(createdAt, now)).not.toContain('ago')
  })
})

describe('isWithinRelativeTimestampWindow', () => {
  const now = new Date('2024-06-01T12:00:00Z')

  it('returns true within 12 hours', () => {
    expect(isWithinRelativeTimestampWindow('2024-06-01T01:00:00Z', now)).toBe(true)
    expect(isWithinRelativeCreatedAtWindow('2024-06-01T01:00:00Z', now)).toBe(true)
  })

  it('returns false at or beyond 12 hours', () => {
    expect(isWithinRelativeTimestampWindow('2024-05-31T23:59:59Z', now)).toBe(false)
  })
})
