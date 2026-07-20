import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatTimestamp,
  getTimestampTooltip,
  isWithinRelativeTimestampWindow,
  parseApiDate,
} from '@/utils/dates'

type TimestampKind = 'created' | 'updated'

interface TimestampLabelProps {
  date: string | Date
  kind: TimestampKind
  className?: string
}

const KIND_STYLES: Record<TimestampKind, string> = {
  created:
    'border-slate-200 bg-slate-100 text-sky-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-sky-400',
  updated:
    'border-slate-200 bg-slate-100 text-amber-700 dark:border-slate-700 dark:bg-slate-800/80 dark:text-amber-400',
}

const KIND_TOOLTIP_PREFIX: Record<TimestampKind, string> = {
  created: 'Created',
  updated: 'Updated',
}

function TimestampLabel({ date, kind, className }: TimestampLabelProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!isWithinRelativeTimestampWindow(date)) return

    const interval = window.setInterval(() => {
      setNow(new Date())
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [date])

  const label = formatTimestamp(date, now)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={parseApiDate(date).toISOString()}
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
              KIND_STYLES[kind],
              className
            )}
          >
            {label}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {KIND_TOOLTIP_PREFIX[kind]} {getTimestampTooltip(date)}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface CreatedAtLabelProps {
  date: string | Date
  className?: string
}

export function CreatedAtLabel({ date, className }: CreatedAtLabelProps) {
  return <TimestampLabel date={date} kind="created" className={className} />
}

interface UpdatedAtLabelProps {
  date: string | Date
  className?: string
}

export function UpdatedAtLabel({ date, className }: UpdatedAtLabelProps) {
  return <TimestampLabel date={date} kind="updated" className={className} />
}

interface EntityTimestampsProps {
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
  className?: string
}

/** Created + updated timestamp badges for entity cards. */
export function EntityTimestamps({ createdAt, updatedAt, className }: EntityTimestampsProps) {
  if (!createdAt && !updatedAt) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {createdAt && <CreatedAtLabel date={createdAt} />}
      {updatedAt && <UpdatedAtLabel date={updatedAt} />}
    </div>
  )
}
