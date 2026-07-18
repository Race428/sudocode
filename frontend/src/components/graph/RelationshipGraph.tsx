/**
 * RelationshipGraph - renders all spec/issue relationships as a graph.
 * Builds nodes/edges from useRelationshipGraph and draws them via GraphCanvas.
 */

import { useCallback, useMemo } from 'react'
import { type Node, type Edge, MarkerType } from '@xyflow/react'

import { GraphCanvas } from './GraphCanvas'
import { EntityNode } from './EntityNode'
import { RelationshipEdge, type EdgeStyle } from './RelationshipEdge'
import { useRelationshipGraph } from '@/hooks/useRelationshipGraph'
import type { RelationshipType } from '@/types/api'

const nodeTypes = { entity: EntityNode }
const edgeTypes = { relationship: RelationshipEdge }

/** Unordered key so A→B and B→A share one parallel group. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

// Edge color per relationship type
const EDGE_COLORS: Record<RelationshipType, string> = {
  blocks: '#ef4444',
  'depends-on': '#f59e0b',
  implements: '#22c55e',
  references: '#94a3b8',
  'discovered-from': '#a855f7',
  related: '#64748b',
}

/**
 * What to render relative to the focused node (no effect without a focus):
 * - 'all'    : the whole graph; the focus node's family is highlighted, the rest dimmed
 * - 'family' : only the focus node and everything transitively connected to it
 * - 'hop1'   : only the focus node and its direct neighbors
 */
export type GraphScope = 'all' | 'family' | 'hop1'

/**
 * Highlight only the focus node's edges of one relationship type/direction.
 * 'out' = focus is the from_id (e.g. focus blocks X); 'in' = focus is the to_id
 * (e.g. focus is blocked by X). Dims everything else and frames the matches.
 */
export interface RelationFilter {
  type: RelationshipType
  direction: 'in' | 'out'
}

export interface RelationshipGraphFilters {
  /** What to render relative to the focused node */
  scope: GraphScope
  /** Hide closed issues */
  hideClosed: boolean
  /** Hide nodes that have no edges */
  hideUnconnected: boolean
  /** Edge rendering: 'curved' diagonal or 'step' 90° */
  edgeStyle: EdgeStyle
  /** Split high-degree hub nodes into per-edge reference copies */
  softClones: boolean
  /** A node is a "hub" (clone candidate) when its degree exceeds this */
  softCloneThreshold: number
}

interface PlacedNode {
  /** React Flow node id (real id, or `${realId}#${edgeIndex}` for a clone) */
  id: string
  /** The underlying entity id */
  realId: string
  isClone: boolean
  cloneIndex?: number
  cloneTotal?: number
}

interface PlacedEdge {
  source: string
  target: string
  rel: { from_id: string; to_id: string; relationship_type: RelationshipType }
}

/** Strip a clone suffix to recover the real entity id. Real ids never contain '#'. */
export const realIdOf = (nodeId: string) => nodeId.split('#')[0]

/**
 * Reduce cross-canvas edges by splitting hub nodes into soft clones: for each
 * edge touching a hub (degree > threshold, never the focus node), replace the
 * hub endpoint with a per-edge copy so dagre places it right next to its
 * neighbor. Edges between two hubs (or two non-hubs) keep their real endpoints,
 * so a hub still renders a real "home" node for its backbone connections.
 */
function expandSoftClones(
  nodeIds: string[],
  edges: PlacedEdge['rel'][],
  focusId: string | undefined,
  threshold: number
): { nodes: PlacedNode[]; edges: PlacedEdge[] } {
  const degree = new Map<string, number>()
  edges.forEach((r) => {
    degree.set(r.from_id, (degree.get(r.from_id) ?? 0) + 1)
    degree.set(r.to_id, (degree.get(r.to_id) ?? 0) + 1)
  })
  const isHub = (id: string) => id !== focusId && (degree.get(id) ?? 0) > threshold

  const placedEdges: PlacedEdge[] = []
  const realNeeded = new Set<string>()
  const cloneNodes: PlacedNode[] = []
  const cloneTotals = new Map<string, number>()

  edges.forEach((rel, i) => {
    const aHub = isHub(rel.from_id)
    const bHub = isHub(rel.to_id)
    let source = rel.from_id
    let target = rel.to_id

    if (aHub && !bHub) {
      source = `${rel.from_id}#${i}`
      cloneNodes.push({ id: source, realId: rel.from_id, isClone: true })
      cloneTotals.set(rel.from_id, (cloneTotals.get(rel.from_id) ?? 0) + 1)
      realNeeded.add(rel.to_id)
    } else if (bHub && !aHub) {
      target = `${rel.to_id}#${i}`
      cloneNodes.push({ id: target, realId: rel.to_id, isClone: true })
      cloneTotals.set(rel.to_id, (cloneTotals.get(rel.to_id) ?? 0) + 1)
      realNeeded.add(rel.from_id)
    } else {
      // both hubs (backbone) or both leaves: keep real endpoints
      realNeeded.add(rel.from_id)
      realNeeded.add(rel.to_id)
    }
    placedEdges.push({ source, target, rel })
  })

  const seen = new Map<string, number>()
  cloneNodes.forEach((n) => {
    const idx = (seen.get(n.realId) ?? 0) + 1
    seen.set(n.realId, idx)
    n.cloneIndex = idx
    n.cloneTotal = cloneTotals.get(n.realId)
  })

  // Real nodes: anchors / backbone endpoints, plus isolated nodes (no edges).
  const realNodes: PlacedNode[] = nodeIds
    .filter((id) => realNeeded.has(id) || !degree.has(id))
    .map((id) => ({ id, realId: id, isClone: false }))

  return { nodes: [...realNodes, ...cloneNodes], edges: placedEdges }
}

/** Build an undirected adjacency map from edge tuples. */
function buildAdjacency(edges: Array<{ from_id: string; to_id: string }>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }
  edges.forEach((e) => {
    add(e.from_id, e.to_id)
    add(e.to_id, e.from_id)
  })
  return adj
}

/** All nodes reachable from `start` (the focus node's "family"), undirected. */
function reachableFrom(start: string, adj: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    adj.get(cur)?.forEach((next) => {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    })
  }
  return seen
}

export interface RelationshipGraphProps {
  /** Entity to highlight and center the view on */
  focusId?: string
  /** Visibility filters */
  filters: RelationshipGraphFilters
  /** Highlight only one relationship type/direction off the focus node */
  relationFilter?: RelationFilter | null
  /** Layout direction */
  direction?: 'TB' | 'LR'
  /** dagre spacing within a rank */
  nodeSpacing?: number
  /** dagre spacing between ranks */
  rankSpacing?: number
  /** Bump to force an auto-format re-layout */
  layoutNonce?: number
  /** Callback when a node is clicked */
  onSelect?: (id: string) => void
  className?: string
}

const edgeKey = (rel: { from_id: string; to_id: string; relationship_type: string }) =>
  `${rel.from_id}-${rel.to_id}-${rel.relationship_type}`

export function RelationshipGraph({
  focusId,
  filters,
  relationFilter,
  direction,
  nodeSpacing,
  rankSpacing,
  layoutNonce,
  onSelect,
  className,
}: RelationshipGraphProps) {
  const { entities, relationships, isLoading } = useRelationshipGraph()

  const { nodes, edges, fitIds } = useMemo(() => {
    const { scope, hideClosed, hideUnconnected } = filters

    // The focus node is always kept, regardless of filters.
    const keep = (id: string): boolean => {
      if (id === focusId) return true
      const e = entities.get(id)
      if (!e) return false
      if (hideClosed && e.type === 'issue' && e.status === 'closed') return false
      return true
    }

    // Edges between two currently-visible entities.
    const visibleEdges = relationships.filter((rel) => keep(rel.from_id) && keep(rel.to_id))
    const adj = buildAdjacency(visibleEdges)

    // The focus node's family: everything transitively connected to it.
    const family = focusId ? reachableFrom(focusId, adj) : null
    const directNeighbors = focusId
      ? new Set<string>([focusId, ...(adj.get(focusId) ?? [])])
      : null

    // Which subset is actually rendered, based on scope (only when focused).
    const inScope = (id: string): boolean => {
      if (!focusId) return true
      if (scope === 'family') return family!.has(id)
      if (scope === 'hop1') return directNeighbors!.has(id)
      return true // 'all'
    }

    const connected = new Set<string>()
    visibleEdges.forEach((rel) => {
      connected.add(rel.from_id)
      connected.add(rel.to_id)
    })

    // Relationship-type highlight: focus + the matching neighbors / edges.
    let highlightNodes: Set<string> | null = null
    let highlightEdgeIds: Set<string> | null = null
    if (relationFilter && focusId) {
      highlightNodes = new Set<string>([focusId])
      highlightEdgeIds = new Set<string>()
      visibleEdges.forEach((rel) => {
        if (rel.relationship_type !== relationFilter.type) return
        if (relationFilter.direction === 'out' && rel.from_id === focusId) {
          highlightNodes!.add(rel.to_id)
          highlightEdgeIds!.add(edgeKey(rel))
        } else if (relationFilter.direction === 'in' && rel.to_id === focusId) {
          highlightNodes!.add(rel.from_id)
          highlightEdgeIds!.add(edgeKey(rel))
        }
      })
    }

    const nodeIds = [...entities.keys()].filter((id) => {
      if (!keep(id)) return false
      if (!inScope(id)) return false
      if (hideUnconnected && id !== focusId && !connected.has(id)) return false
      return true
    })

    // Dimming: an active relationship-type highlight wins; otherwise in 'all'
    // scope the focus node's family stays lit and the rest dims.
    const isDimmed = (id: string): boolean => {
      if (highlightNodes) return id !== focusId && !highlightNodes.has(id)
      return !!focusId && scope === 'all' && id !== focusId && !family!.has(id)
    }

    const nodeIdSet = new Set(nodeIds)
    const renderedRels = visibleEdges.filter(
      (rel) => nodeIdSet.has(rel.from_id) && nodeIdSet.has(rel.to_id)
    )

    // Placement: optionally split hub nodes into soft clones. Either way we end
    // up with a flat list of placed nodes (real or clone) and placed edges.
    const placed = filters.softClones
      ? expandSoftClones(nodeIds, renderedRels, focusId, filters.softCloneThreshold)
      : {
          nodes: nodeIds.map((id) => ({ id, realId: id, isClone: false }) as PlacedNode),
          edges: renderedRels.map(
            (rel) => ({ source: rel.from_id, target: rel.to_id, rel }) as PlacedEdge
          ),
        }

    const nodes: Node[] = placed.nodes.map((pn) => {
      const entity = entities.get(pn.realId)!
      return {
        id: pn.id,
        type: 'entity',
        position: { x: 0, y: 0 },
        data: {
          entity,
          isFocused: !pn.isClone && pn.realId === focusId,
          dimmed: isDimmed(pn.realId),
          isClone: pn.isClone,
          cloneIndex: pn.cloneIndex,
          cloneTotal: pn.cloneTotal,
          onSelect,
        },
      }
    })

    // Count edges per (placed) node-pair so parallel ones can be fanned apart.
    const groupCount = new Map<string, number>()
    placed.edges.forEach((pe) => {
      const k = pairKey(pe.source, pe.target)
      groupCount.set(k, (groupCount.get(k) ?? 0) + 1)
    })
    const groupSeen = new Map<string, number>()

    const edges: Edge[] = placed.edges.map((pe, i) => {
      const rel = pe.rel
      const color = EDGE_COLORS[rel.relationship_type] ?? '#94a3b8'
      const dimmed = highlightEdgeIds
        ? !highlightEdgeIds.has(edgeKey(rel))
        : isDimmed(rel.from_id) || isDimmed(rel.to_id)
      const k = pairKey(pe.source, pe.target)
      const index = groupSeen.get(k) ?? 0
      groupSeen.set(k, index + 1)
      return {
        id: `${pe.source}-${pe.target}-${rel.relationship_type}-${i}`,
        source: pe.source,
        target: pe.target,
        type: 'relationship',
        data: {
          color,
          label: rel.relationship_type,
          index,
          count: groupCount.get(k) ?? 1,
          // Canonical fan axis so A→B and B→A bow to opposite sides instead of
          // both flipping perpendicular and landing back on top of each other.
          orient: pe.source < pe.target ? 1 : -1,
          edgeStyle: filters.edgeStyle,
          dimmed,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      }
    })

    // Frame the rendered nodes (real or clone) whose entity is highlighted.
    const fitIds = highlightNodes
      ? placed.nodes.filter((pn) => highlightNodes!.has(pn.realId)).map((pn) => pn.id)
      : undefined
    return { nodes, edges, fitIds }
  }, [entities, relationships, focusId, filters, relationFilter, onSelect])

  const miniMapNodeColor = useCallback(
    (node: Node) => ((node.data as { entity?: { type?: string } })?.entity?.type === 'spec' ? '#a855f7' : '#0ea5e9'),
    []
  )

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Loading graph…</p>
      </div>
    )
  }

  return (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={(id) => onSelect?.(realIdOf(id))}
      miniMapNodeColor={miniMapNodeColor}
      groupKeyOf={
        filters.softClones
          ? (node) => (node.data as { entity?: { id?: string } })?.entity?.id
          : undefined
      }
      focusNodeId={focusId}
      fitNodeIds={fitIds}
      direction={direction}
      nodeSpacing={nodeSpacing}
      rankSpacing={rankSpacing}
      layoutNonce={layoutNonce}
      nodesDraggable
      emptyMessage="No relationships to display yet"
      className={className}
    />
  )
}

export default RelationshipGraph
