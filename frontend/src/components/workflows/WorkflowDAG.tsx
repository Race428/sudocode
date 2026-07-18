/**
 * WorkflowDAG - DAG visualization component for workflow steps.
 * Builds nodes/edges from workflow steps and renders them via GraphCanvas.
 */

import { useCallback, useMemo } from 'react'
import { type Node, type Edge, MarkerType } from '@xyflow/react'

import type { WorkflowStep } from '@/types/workflow'
import type { Issue } from '@/types/api'
import { WorkflowStepNode } from './WorkflowStepNode'
import { GraphCanvas } from '@/components/graph/GraphCanvas'

// =============================================================================
// Types
// =============================================================================

export interface WorkflowDAGProps {
  /** Workflow steps to visualize */
  steps: WorkflowStep[]
  /** Optional issue data for enriching step display */
  issues?: Record<string, Issue>
  /** Currently selected step ID */
  selectedStepId?: string
  /** Callback when a step is selected */
  onStepSelect?: (stepId: string) => void
  /** Callback when clicking on empty pane area (useful for deselecting) */
  onPaneClick?: () => void
  /** Callback for step actions (retry, skip, cancel) */
  onStepAction?: (stepId: string, action: 'retry' | 'skip' | 'cancel') => void
  /** Whether the DAG is interactive (default: true) */
  interactive?: boolean
  /** Show minimap (default: true) */
  showMinimap?: boolean
  /** Show controls (default: true) */
  showControls?: boolean
  /** Custom class name */
  className?: string
}

// =============================================================================
// Element conversion
// =============================================================================

/**
 * Convert WorkflowStep[] to React Flow nodes and edges
 */
function stepsToFlowElements(
  steps: WorkflowStep[],
  issues?: Record<string, Issue>,
  selectedStepId?: string,
  onStepSelect?: (stepId: string) => void
): { nodes: Node[]; edges: Edge[] } {
  // Create nodes from steps
  const nodes: Node[] = steps.map((step) => ({
    id: step.id,
    type: 'workflowStep',
    position: { x: 0, y: 0 }, // Will be calculated by dagre
    data: {
      step,
      issue: issues?.[step.issueId],
      isSelected: step.id === selectedStepId,
      onSelect: onStepSelect,
    },
  }))

  // Create edges from dependencies
  const edges: Edge[] = []
  steps.forEach((step) => {
    step.dependencies.forEach((depId) => {
      // Find if dependency exists in steps
      const depExists = steps.some((s) => s.id === depId)
      if (depExists) {
        const isTargetRunning = step.status === 'running'
        const isSourceCompleted =
          steps.find((s) => s.id === depId)?.status === 'completed'

        edges.push({
          id: `${depId}-${step.id}`,
          source: depId,
          target: step.id,
          type: 'smoothstep',
          animated: isTargetRunning,
          style: {
            stroke: isSourceCompleted ? '#22c55e' : '#94a3b8',
            strokeWidth: 2,
            opacity: isSourceCompleted ? 0.6 : 1,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isSourceCompleted ? '#22c55e' : '#94a3b8',
          },
        })
      }
    })
  })

  return { nodes, edges }
}

const nodeTypes = {
  workflowStep: WorkflowStepNode,
}

function miniMapNodeColor(node: Node): string {
  const step = node.data?.step as WorkflowStep | undefined
  if (!step) return '#94a3b8'
  switch (step.status) {
    case 'completed':
      return '#22c55e'
    case 'running':
      return '#3b82f6'
    case 'failed':
      return '#ef4444'
    case 'blocked':
      return '#eab308'
    case 'skipped':
      return '#9ca3af'
    case 'ready':
      return '#3b82f6'
    default:
      return '#94a3b8'
  }
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowDAG({
  steps,
  issues,
  selectedStepId,
  onStepSelect,
  onPaneClick,
  // onStepAction - will be used when context menu is implemented
  onStepAction: _onStepAction,
  interactive = true,
  showMinimap = true,
  showControls = true,
  className,
}: WorkflowDAGProps) {
  const { nodes, edges } = useMemo(
    () => stepsToFlowElements(steps, issues, selectedStepId, onStepSelect),
    [steps, issues, selectedStepId, onStepSelect]
  )

  const handleNodeClick = useCallback(
    (id: string) => onStepSelect?.(id),
    [onStepSelect]
  )

  return (
    <GraphCanvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={handleNodeClick}
      onPaneClick={onPaneClick}
      interactive={interactive}
      showMinimap={showMinimap}
      showControls={showControls}
      miniMapNodeColor={miniMapNodeColor}
      emptyMessage="No steps in workflow"
      className={className}
    />
  )
}

export default WorkflowDAG
