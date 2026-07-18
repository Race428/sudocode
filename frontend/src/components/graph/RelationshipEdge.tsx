/**
 * RelationshipEdge - custom edge that fans parallel edges apart.
 *
 * dagre lays out nodes, not edges, so multiple relationships between the same
 * pair of nodes (e.g. blocks + references + implements) draw the identical
 * path and stack exactly on top of each other. This edge bows each one by a
 * perpendicular offset based on its index within the parallel group, so they
 * spread into a readable fan. A lone edge (count 1) draws straight.
 */

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

export type EdgeStyle = 'curved' | 'step'

export interface RelationshipEdgeData {
  color: string
  label: string
  /** Position within the group of edges sharing this node pair */
  index: number
  /** Size of that group */
  count: number
  /** Canonical fan direction (+1/-1) so reversed edges don't cancel the offset */
  orient?: number
  /** 'curved' = diagonal bezier, 'step' = 90° orthogonal */
  edgeStyle?: EdgeStyle
  dimmed?: boolean
  [key: string]: unknown
}

// Perpendicular pixels between adjacent parallel edges.
const SPACING = 26

export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const {
    color,
    label,
    index,
    count,
    orient = 1,
    edgeStyle = 'curved',
    dimmed,
  } = (data ?? {}) as RelationshipEdgeData

  const mx = (sourceX + targetX) / 2
  const my = (sourceY + targetY) / 2
  // Center the fan on the straight line: -(n-1)/2 … +(n-1)/2, on a canonical axis
  const offset = (index - (count - 1) / 2) * SPACING * orient

  let path: string
  let labelX: number
  let labelY: number

  if (edgeStyle === 'step') {
    // 90° orthogonal route; shift the vertical segment sideways to fan parallels
    const [stepPath, lx, ly] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 8,
      centerX: mx + offset,
    })
    path = stepPath
    labelX = lx
    labelY = ly
  } else {
    // Diagonal bezier bowed by the perpendicular offset
    const dx = targetX - sourceX
    const dy = targetY - sourceY
    const len = Math.hypot(dx, dy) || 1
    const px = -dy / len
    const py = dx / len
    const cx = mx + px * offset
    const cy = my + py * offset
    path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`
    // Quadratic midpoint sits halfway to the control point
    labelX = mx + px * offset * 0.5
    labelY = my + py * offset * 0.5
  }

  const opacity = dimmed ? 0.15 : 1

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: 2, opacity }} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded bg-background/80 px-1 text-[10px] font-medium"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color,
              opacity,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default RelationshipEdge
