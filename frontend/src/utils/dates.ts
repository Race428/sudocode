const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000
const ONE_MINUTE_MS = 60 * 1000

/** Parse API timestamps that may omit a timezone suffix. */
export function parseApiDate(date: string | Date): Date {
  if (date instanceof Date) return date
  const normalized = date.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(date) ? date : `${date}Z`
  return new Date(normalized)
}

function formatRelativeHoursAndMinutes(diffMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(diffMs / ONE_MINUTE_MS))

  if (totalMinutes < 1) {
    return 'just now'
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) {
    return `${minutes}m ago`
  }

  if (minutes === 0) {
    return `${hours}h ago`
  }

  return `${hours}h ${minutes}m ago`
}

/** Format created-at for cards: relative within 12h, absolute date/time otherwise. */
export function formatCreatedAt(date: string | Date, now: Date = new Date()): string {
  const createdAt = parseApiDate(date)
  const diffMs = now.getTime() - createdAt.getTime()

  if (diffMs >= 0 && diffMs < TWELVE_HOURS_MS) {
    return formatRelativeHoursAndMinutes(diffMs)
  }

  return createdAt.toLocaleString('en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
}

export function isWithinRelativeCreatedAtWindow(
  date: string | Date,
  now: Date = new Date()
): boolean {
  const createdAt = parseApiDate(date)
  const diffMs = now.getTime() - createdAt.getTime()
  return diffMs >= 0 && diffMs < TWELVE_HOURS_MS
}

export function getCreatedAtTooltip(date: string | Date): string {
  return parseApiDate(date).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}
