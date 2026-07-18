import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { relationshipsApi } from '@/lib/api'
import { useProject } from '@/hooks/useProject'
import { useIssues } from '@/hooks/useIssues'
import { useSpecs } from '@/hooks/useSpecs'
import { useWebSocketContext } from '@/contexts/WebSocketContext'
import type { EntityType, Relationship, WebSocketMessage } from '@/types/api'

export interface GraphEntity {
  id: string
  type: EntityType
  title: string
  /** Present for issues */
  status?: string
}

/**
 * Fetches every issue + spec and the relationships between them, deduped into a
 * single edge list. Backs the standalone relationship graph view.
 *
 * No dedicated "list all relationships" endpoint exists, so this fans out
 * getForEntity over every entity (same approach as useIssueRelationships) and
 * dedupes. Fine for hundreds of entities; add a server endpoint if it gets slow.
 */
export function useRelationshipGraph() {
  const queryClient = useQueryClient()
  const { currentProjectId } = useProject()
  const { connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler } =
    useWebSocketContext()

  const { issues } = useIssues()
  const { specs } = useSpecs()

  const entities = useMemo(() => {
    const map = new Map<string, GraphEntity>()
    issues.forEach((i) => map.set(i.id, { id: i.id, type: 'issue', title: i.title, status: i.status }))
    specs.forEach((s) => map.set(s.id, { id: s.id, type: 'spec', title: s.title }))
    return map
  }, [issues, specs])

  const entityKeys = useMemo(() => [...entities.keys()].sort(), [entities])

  const query = useQuery({
    queryKey: ['relationship-graph', currentProjectId, entityKeys],
    queryFn: async () => {
      const perEntity = await Promise.all(
        [...entities.values()].map((e) =>
          relationshipsApi
            .getForEntity(e.id, e.type)
            .then((data): Relationship[] => {
              if (Array.isArray(data)) return data
              if (data && typeof data === 'object' && 'outgoing' in data && 'incoming' in data) {
                const grouped = data as { outgoing: Relationship[]; incoming: Relationship[] }
                return [...(grouped.outgoing || []), ...(grouped.incoming || [])]
              }
              return []
            })
            .catch(() => [])
        )
      )

      const seen = new Set<string>()
      const relationships: Relationship[] = []
      perEntity.flat().forEach((rel) => {
        const key = `${rel.from_id}|${rel.to_id}|${rel.relationship_type}`
        if (!seen.has(key)) {
          seen.add(key)
          relationships.push(rel)
        }
      })
      return relationships
    },
    enabled: entityKeys.length > 0 && !!currentProjectId,
    staleTime: 5 * 60 * 1000,
  })

  // Refetch when relationships change elsewhere
  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === 'relationship_created' || message.type === 'relationship_deleted') {
        queryClient.invalidateQueries({ queryKey: ['relationship-graph', currentProjectId] })
      }
    },
    [queryClient, currentProjectId]
  )

  useEffect(() => {
    const handlerId = 'useRelationshipGraph'
    addMessageHandler(handlerId, handleMessage)
    if (connected) subscribe('all')
    return () => {
      removeMessageHandler(handlerId)
      unsubscribe('all')
    }
  }, [connected, subscribe, unsubscribe, addMessageHandler, removeMessageHandler, handleMessage])

  return {
    entities,
    relationships: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  }
}
