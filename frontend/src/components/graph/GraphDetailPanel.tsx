/**
 * GraphDetailPanel - side panel shown when a graph node is focused.
 *
 * Reuses the real issue-page component (IssuePanel) and spec content viewer so
 * the details match the rest of the app, and adds a graph-specific "Show
 * connections" bar that highlights one relationship type/direction on the graph.
 */

import { useMemo } from 'react'
import { X, ExternalLink, FileText, CircleDot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RELATIONSHIP_COLORS, RELATIONSHIP_LABELS, getInverseLabel } from '@/lib/relationships'
import { useRelationshipGraph } from '@/hooks/useRelationshipGraph'
import { useIssue, useIssues, useIssueFeedback } from '@/hooks/useIssues'
import { useSpec } from '@/hooks/useSpecs'
import IssuePanel from '@/components/issues/IssuePanel'
import { SpecViewerTiptap } from '@/components/specs/SpecViewerTiptap'
import type { RelationFilter } from './RelationshipGraph'
import type { Issue, RelationshipType } from '@/types/api'

interface Bucket {
  type: RelationshipType
  direction: 'in' | 'out'
  label: string
  count: number
}

export interface GraphDetailPanelProps {
  focusId: string
  activeFilter: RelationFilter | null
  onFilter: (filter: RelationFilter | null) => void
  onClose: () => void
  onOpenFull: (id: string) => void
}

export function GraphDetailPanel({
  focusId,
  activeFilter,
  onFilter,
  onClose,
  onOpenFull,
}: GraphDetailPanelProps) {
  const { entities, relationships } = useRelationshipGraph()
  const entity = entities.get(focusId)
  const isIssue = entity?.type === 'issue'

  // Only the matching hook actually fetches (the other gets an empty id).
  const { data: issue } = useIssue(isIssue ? focusId : '')
  const { spec } = useSpec(!isIssue && entity ? focusId : '')
  const { feedback } = useIssueFeedback(isIssue ? focusId : '')
  const { issues, updateIssue, isUpdating } = useIssues()

  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>()
    relationships.forEach((rel) => {
      if (rel.from_id !== focusId && rel.to_id !== focusId) return
      const direction: 'in' | 'out' = rel.from_id === focusId ? 'out' : 'in'
      const label =
        direction === 'out'
          ? RELATIONSHIP_LABELS[rel.relationship_type]
          : getInverseLabel(rel.relationship_type)
      const key = `${rel.relationship_type}:${direction}`
      const b = map.get(key) ?? { type: rel.relationship_type, direction, label, count: 0 }
      b.count++
      map.set(key, b)
    })
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [relationships, focusId])

  return (
    <aside className="flex w-[460px] shrink-0 flex-col border-l bg-background">
      {/* Slim header */}
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {isIssue ? (
            <CircleDot className="h-3.5 w-3.5 shrink-0 text-sky-500" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-violet-500" />
          )}
          <span className="truncate font-mono">{entity?.id ?? focusId}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => onOpenFull(focusId)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open full page
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Show-connections highlight bar (graph-specific) */}
      <div className="border-b px-4 py-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Show connections</p>
        {buckets.length === 0 ? (
          <p className="text-xs text-muted-foreground">No relationships.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {buckets.map((b) => {
              const active =
                activeFilter?.type === b.type && activeFilter?.direction === b.direction
              return (
                <button
                  key={`${b.type}:${b.direction}`}
                  onClick={() => onFilter(active ? null : { type: b.type, direction: b.direction })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors',
                    active
                      ? `${RELATIONSHIP_COLORS[b.type]} text-white`
                      : 'bg-muted text-foreground hover:bg-muted/70'
                  )}
                >
                  {b.label}
                  <span className={cn('rounded-full px-1', active ? 'bg-white/20' : 'bg-background')}>
                    {b.count}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {activeFilter && (
          <button
            onClick={() => onFilter(null)}
            className="mt-2 text-xs text-muted-foreground underline hover:text-foreground"
          >
            Clear highlight
          </button>
        )}
      </div>

      {/* Entity details — same components as the issue / spec pages */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isIssue ? (
          issue ? (
            <IssuePanel
              issue={issue}
              issues={issues}
              feedback={feedback}
              onUpdate={(data: Partial<Issue>) => updateIssue({ id: focusId, data })}
              isUpdating={isUpdating}
              hideTopControls
            />
          ) : (
            <PanelLoading />
          )
        ) : spec ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <h2 className="mb-3 text-sm font-semibold leading-tight">{spec.title}</h2>
            <SpecViewerTiptap content={spec.content} />
          </div>
        ) : (
          <PanelLoading />
        )}
      </div>
    </aside>
  )
}

function PanelLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  )
}

export default GraphDetailPanel
