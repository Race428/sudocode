import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  formatCreatedAt,
  getCreatedAtTooltip,
  isWithinRelativeCreatedAtWindow,
  parseApiDate,
} from '@/utils/dates'

interface CreatedAtLabelProps {
  date: string | Date
  className?: string
}

export function CreatedAtLabel({ date, className }: CreatedAtLabelProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!isWithinRelativeCreatedAtWindow(date)) return

    const interval = window.setInterval(() => {
      setNow(new Date())
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [date])

  const label = formatCreatedAt(date, now)

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={parseApiDate(date).toISOString()}
            className={cn(
              'inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-medium text-sky-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-sky-400',
              className
            )}
          >
            {label}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          <p>Created {getCreatedAtTooltip(date)}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
