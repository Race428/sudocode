/**
 * GraphCanvas - generic React Flow + dagre canvas.
 *
 * Renders pre-built nodes/edges with automatic dagre layout. Knows nothing
 * about workflows, issues, or specs — callers build their own nodes/edges and
 * pass a nodeTypes map. Extracted from WorkflowDAG so it can back both the
 * workflow DAG and the standalone relationship graph.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
  type ReactFlowInstance,
  Position,
} from '@xyflow/react'
import dagre from 'dagre'
import '@xyflow/react/dist/style.css'

import { useTheme } from '@/contexts/ThemeContext'
import { GraphHoverContext } from './graphHoverContext'

// Default node dimensions for layout calculation
const DEFAULT_NODE_WIDTH = 280
const DEFAULT_NODE_HEIGHT = 80

/**
 * Apply dagre layout to nodes and edges. Returns nodes with calculated positions.
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
  nodeWidth = DEFAULT_NODE_WIDTH,
  nodeHeight = DEFAULT_NODE_HEIGHT,
  nodeSep = 50,
  rankSep = 80
): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph()
  dagreGraph.setDefaultEdgeLabel(() => ({}))

  const isHorizontal = direction === 'LR'
  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: nodeSep,
    ranksep: rankSep,
    marginx: 20,
    marginy: 20,
  })

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  })

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target)
  })

  dagre.layout(dagreGraph)

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id)
    return {
      ...node,
      targetPosition: isHorizontal ? Position.Left : Position.Top,
      sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    }
  })

  return { nodes: layoutedNodes, edges }
}

export interface GraphCanvasProps {
  /** Un-positioned nodes (dagre assigns positions) */
  nodes: Node[]
  /** Edges between nodes */
  edges: Edge[]
  /** Custom node renderers keyed by node.type */
  nodeTypes: NodeTypes
  /** Custom edge renderers keyed by edge.type */
  edgeTypes?: EdgeTypes
  /** Layout direction (default: 'TB') */
  direction?: 'TB' | 'LR'
  /** Node dimensions used for layout (defaults: 280x80) */
  nodeWidth?: number
  nodeHeight?: number
  /** dagre spacing between nodes in the same rank (default: 50) */
  nodeSpacing?: number
  /** dagre spacing between ranks (default: 80) */
  rankSpacing?: number
  /** Bump to force a fresh dagre re-layout (discards manual drag positions) */
  layoutNonce?: number
  /** Callback when a node is clicked */
  onNodeClick?: (id: string) => void
  /** Callback when clicking empty pane (useful for deselecting) */
  onPaneClick?: () => void
  /** Whether the canvas is interactive (default: true) */
  interactive?: boolean
  /** Allow dragging nodes to reposition them (default: false) */
  nodesDraggable?: boolean
  /** Show minimap (default: true) */
  showMinimap?: boolean
  /** Show controls (default: true) */
  showControls?: boolean
  /** Color a node in the minimap */
  miniMapNodeColor?: (node: Node) => string
  /**
   * When provided, hovering a node broadcasts this key so every node with the
   * same key can highlight together (used for soft-clone siblings). Omit to
   * disable hover grouping entirely.
   */
  groupKeyOf?: (node: Node) => string | undefined
  /** Pan/zoom to this node when set (instead of fitting the whole graph) */
  focusNodeId?: string
  /** Pan/zoom to fit exactly these nodes (overrides focusNodeId when non-empty) */
  fitNodeIds?: string[]
  /** Message shown when there are no nodes */
  emptyMessage?: string
  /** Custom class name */
  className?: string
}

export function GraphCanvas({
  nodes: inputNodes,
  edges: inputEdges,
  nodeTypes,
  edgeTypes,
  direction = 'TB',
  nodeWidth,
  nodeHeight,
  nodeSpacing,
  rankSpacing,
  layoutNonce,
  onNodeClick,
  onPaneClick,
  interactive = true,
  nodesDraggable = false,
  showMinimap = true,
  showControls = true,
  miniMapNodeColor,
  groupKeyOf,
  focusNodeId,
  fitNodeIds,
  emptyMessage = 'Nothing to display',
  className,
}: GraphCanvasProps) {
  const { actualTheme } = useTheme()
  const isDark = actualTheme === 'dark'
  const rfRef = useRef<ReactFlowInstance | null>(null)
  // Hovered group key — broadcast via context so sibling nodes re-render
  // without touching the node array (which would retrigger layout).
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null)
  const onNodeMouseEnter = useMemo<NodeMouseHandler | undefined>(
    () => (groupKeyOf ? (_e, node) => setHoveredGroup(groupKeyOf(node) ?? null) : undefined),
    [groupKeyOf]
  )
  const onNodeMouseLeave = useMemo<(() => void) | undefined>(
    () => (groupKeyOf ? () => setHoveredGroup(null) : undefined),
    [groupKeyOf]
  )
  // Whether the canvas mounted already pointing at something (deep link / "see
  // in graph"). If so the first framing zooms in; later focus changes only pan.
  const mountedFramedRef = useRef<boolean | null>(null)
  if (mountedFramedRef.current === null) {
    mountedFramedRef.current = !!(fitNodeIds?.length || focusNodeId)
  }
  const framedOnceRef = useRef(false)

  const { initialNodes, initialEdges } = useMemo(() => {
    const layouted = getLayoutedElements(
      inputNodes,
      inputEdges,
      direction,
      nodeWidth,
      nodeHeight,
      nodeSpacing,
      rankSpacing
    )
    return { initialNodes: layouted.nodes, initialEdges: layouted.edges }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputNodes, inputEdges, direction, nodeWidth, nodeHeight, nodeSpacing, rankSpacing, layoutNonce])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Re-layout when inputs (or layoutNonce) change. layoutNonce lets an
  // "auto-format" button force a fresh dagre pass, discarding manual drags.
  useEffect(() => {
    const layouted = getLayoutedElements(
      inputNodes,
      inputEdges,
      direction,
      nodeWidth,
      nodeHeight,
      nodeSpacing,
      rankSpacing
    )
    setNodes(layouted.nodes)
    setEdges(layouted.edges)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputNodes, inputEdges, direction, nodeWidth, nodeHeight, nodeSpacing, rankSpacing, layoutNonce, setNodes, setEdges])

  // Which nodes to frame: an explicit fit set wins, else the focus node.
  const fitTargets = useMemo(
    () => (fitNodeIds && fitNodeIds.length ? fitNodeIds : focusNodeId ? [focusNodeId] : []),
    [fitNodeIds, focusNodeId]
  )
  const fitKey = fitTargets.join(',')
  // Recomputes on drag but stays the same value, so the effect below doesn't
  // re-fire mid-drag (its deps are fitKey + this boolean, not node positions).
  const fitReady = useMemo(
    () => fitTargets.some((id) => nodes.some((n) => n.id === id)),
    [fitTargets, nodes]
  )

  // Frame the target nodes once they exist in the laid-out graph.
  // - A multi-node fit set (relationship highlight) always zooms to fit.
  // - The very first framing zooms only if we arrived already focused.
  // - Otherwise (focusing a new node while in the graph) we just pan/center,
  //   keeping the current zoom level.
  // Deferred a tick so React Flow has measured the new nodes before framing.
  useEffect(() => {
    if (!fitReady) return
    const present = fitTargets.filter((id) => nodes.some((n) => n.id === id))
    if (!present.length) return
    const isSubset = !!(fitNodeIds && fitNodeIds.length)
    const zoomToFit = isSubset || (!framedOnceRef.current && mountedFramedRef.current)
    const t = setTimeout(() => {
      const rf = rfRef.current
      if (!rf) return
      if (zoomToFit) {
        rf.fitView({
          nodes: present.map((id) => ({ id })),
          duration: 400,
          maxZoom: 1.4,
          padding: isSubset ? 0.5 : 0.6,
        })
      } else {
        // Pan only — center the node, keep the current zoom.
        const n = rf.getNode(present[0])
        if (n) {
          const w = n.measured?.width ?? n.width ?? 0
          const h = n.measured?.height ?? n.height ?? 0
          rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, {
            zoom: rf.getZoom(),
            duration: 400,
          })
        }
      }
      framedOnceRef.current = true
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, fitReady, layoutNonce])

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (interactive && onNodeClick) {
        onNodeClick(node.id)
      }
    },
    [interactive, onNodeClick]
  )

  if (inputNodes.length === 0) {
    return (
      <div
        className={`flex h-full items-center justify-center text-muted-foreground ${className ?? ''}`}
      >
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className={`h-full w-full ${className ?? ''}`}>
      <GraphHoverContext.Provider value={hoveredGroup}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onInit={(instance) => (rfRef.current = instance)}
          onNodesChange={interactive ? onNodesChange : undefined}
          onEdgesChange={interactive ? onEdgesChange : undefined}
          onNodeClick={handleNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={actualTheme}
          fitView={fitTargets.length === 0}
          fitViewOptions={{
            padding: 0.2,
            minZoom: 0.5,
            maxZoom: 1.5,
          }}
          minZoom={0.25}
          maxZoom={2}
          nodesDraggable={interactive && nodesDraggable}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={interactive}
          zoomOnScroll={interactive}
          zoomOnPinch={interactive}
          zoomOnDoubleClick={interactive}
          preventScrolling={interactive}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={isDark ? '#334155' : '#e2e8f0'} gap={16} size={1} />
          {showControls && <Controls showInteractive={false} />}
          {showMinimap && (
            <MiniMap
              nodeColor={miniMapNodeColor}
              maskColor={isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.1)'}
              className="rounded-lg border bg-background"
            />
          )}
        </ReactFlow>
      </GraphHoverContext.Provider>
    </div>
  )
}

export default GraphCanvas
