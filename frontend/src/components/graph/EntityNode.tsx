/**
 * EntityNode - React Flow node for an issue or spec in the relationship graph.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { FileText, CircleDot, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GraphEntity } from '@/hooks/useRelationshipGraph'
import { useGraphHover } from './graphHoverContext'

export interface EntityNodeData {
  entity: GraphEntity
  isFocused?: boolean
  /** Not part of the focused node's family — render faded */
  dimmed?: boolean
  /** This is a soft clone (reference copy) of an entity rendered elsewhere */
  isClone?: boolean
  /** 1-based position among this entity's clones, for the "1 of N" badge */
  cloneIndex?: number
  cloneTotal?: number
  onSelect?: (id: string) => void
  [key: string]: unknown
}

export const EntityNode = memo(({ data }: NodeProps) => {
  const { entity, isFocused, dimmed, isClone, cloneIndex, cloneTotal, onSelect } =
    data as EntityNodeData
  const isSpec = entity.type === 'spec'
  const title = entity.title.length > 36 ? `${entity.title.slice(0, 36)}…` : entity.title

  // Any instance of the hovered entity (real node or one of its clones) lights up.
  const hoveredGroup = useGraphHover()
  const isSibling = !!hoveredGroup && hoveredGroup === entity.id

  const handleClass =
    '!h-2 !w-2 !border-2 !border-background !rounded-full !bg-muted-foreground'

  return (
    <>
      <Handle type="target" position={Position.Top} className={handleClass} />

      <div
        onClick={() => onSelect?.(entity.id)}
        className={cn(
          'rounded-lg border-2 p-3 shadow-sm transition-opacity',
          'min-w-[220px] max-w-[280px] cursor-pointer select-none hover:bg-muted/50',
          isSpec ? 'border-violet-400/60' : 'border-sky-400/60',
          // Clones read as ghostly references: dashed border, muted fill.
          isClone ? 'border-dashed bg-muted/40' : 'bg-background',
          isFocused && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
          // Sibling highlight wins over dimming so you can spot every copy.
          isSibling && !isFocused && 'ring-2 ring-amber-400',
          isSibling ? 'opacity-100' : dimmed ? 'opacity-25 hover:opacity-100' : undefined
        )}
      >
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            {isSpec ? (
              <FileText className="h-3.5 w-3.5 text-violet-500" />
            ) : (
              <CircleDot className="h-3.5 w-3.5 text-sky-500" />
            )}
            <span className="font-mono font-medium">{entity.id}</span>
          </div>
          {isClone ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium">
              <Link2 className="h-3 w-3" />
              ref{cloneTotal ? ` ${cloneIndex}/${cloneTotal}` : ''}
            </span>
          ) : (
            entity.status && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{entity.status}</span>
            )
          )}
        </div>

        <div className="my-2 border-t border-border/50" />

        <div className={cn('text-sm font-medium leading-tight', isClone && 'italic opacity-80')}>
          {title}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </>
  )
})

EntityNode.displayName = 'EntityNode'
