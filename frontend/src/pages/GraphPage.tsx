/**
 * GraphPage - standalone view of how specs and issues relate.
 * Optional ?focus=<id> highlights and centers a single entity.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Network, Wand2, Settings2 } from 'lucide-react'
import { RelationshipGraph, realIdOf } from '@/components/graph/RelationshipGraph'
import type {
  GraphScope,
  RelationFilter,
  RelationshipGraphFilters,
} from '@/components/graph/RelationshipGraph'
import type { EdgeStyle } from '@/components/graph/RelationshipEdge'
import { GraphDetailPanel } from '@/components/graph/GraphDetailPanel'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProjectRoutes } from '@/hooks/useProjectRoutes'

const SCOPE_OPTIONS: Array<{ value: GraphScope; label: string }> = [
  { value: 'family', label: 'Family tree' },
  { value: 'hop1', label: '1 hop' },
  { value: 'all', label: 'Whole graph' },
]

const EDGE_STYLE_OPTIONS: Array<{ value: EdgeStyle; label: string }> = [
  { value: 'curved', label: 'Diagonal' },
  { value: 'step', label: '90° angles' },
]

interface LayoutSettings {
  direction: 'TB' | 'LR'
  nodeSpacing: number
  rankSpacing: number
}

export default function GraphPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  // Normalize away any stray clone suffix (e.g. a stale ?focus=s-x%231 deep link).
  const rawFocus = searchParams.get('focus')
  const focusId = rawFocus ? realIdOf(rawFocus) : undefined
  const { go } = useProjectRoutes()

  const [filters, setFilters] = useState<RelationshipGraphFilters>({
    scope: 'family',
    hideClosed: true,
    hideUnconnected: true,
    edgeStyle: 'step',
    softClones: false,
    softCloneThreshold: 3,
  })
  const setFilter = useCallback(
    <K extends keyof RelationshipGraphFilters>(key: K, value: RelationshipGraphFilters[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    []
  )

  const [relationFilter, setRelationFilter] = useState<RelationFilter | null>(null)
  // Reset the relationship-type highlight whenever the focused node changes.
  useEffect(() => setRelationFilter(null), [focusId])

  const [layout, setLayout] = useState<LayoutSettings>({
    direction: 'TB',
    nodeSpacing: 50,
    rankSpacing: 80,
  })
  const [layoutNonce, setLayoutNonce] = useState(0)
  const autoFormat = useCallback(() => setLayoutNonce((n) => n + 1), [])

  // Clicking a node focuses it (and opens the side panel).
  const handleSelect = useCallback(
    (id: string) => {
      if (id === focusId) return
      setSearchParams((prev) => {
        prev.set('focus', id)
        return prev
      })
    },
    [focusId, setSearchParams]
  )

  const openFull = useCallback(
    (id: string) => (id.startsWith('s-') ? go.spec(id) : go.issue(id)),
    [go]
  )

  const closePanel = useCallback(() => {
    setSearchParams((prev) => {
      prev.delete('focus')
      return prev
    })
  }, [setSearchParams])

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Relationship Graph</h1>
          {focusId && (
            <span className="ml-1 rounded bg-muted px-2 py-0.5 font-mono text-sm text-muted-foreground">
              {focusId}
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Label htmlFor="scope" className="text-muted-foreground">
              Show
            </Label>
            <Select
              value={filters.scope}
              onValueChange={(v) => setFilter('scope', v as GraphScope)}
              disabled={!focusId}
            >
              <SelectTrigger id="scope" className="h-8 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="edge-style" className="text-muted-foreground">
              Edges
            </Label>
            <Select
              value={filters.edgeStyle}
              onValueChange={(v) => setFilter('edgeStyle', v as EdgeStyle)}
            >
              <SelectTrigger id="edge-style" className="h-8 w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDGE_STYLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Toggle
            id="hide-closed"
            label="Hide closed"
            checked={filters.hideClosed}
            onChange={(v) => setFilter('hideClosed', v)}
          />
          <Toggle
            id="hide-unconnected"
            label="Hide unconnected"
            checked={filters.hideUnconnected}
            onChange={(v) => setFilter('hideUnconnected', v)}
          />
          <Toggle
            id="soft-clones"
            label="Soft clones"
            checked={filters.softClones}
            onChange={(v) => setFilter('softClones', v)}
          />

          {/* Auto-format + layout settings */}
          <div className="flex items-center">
            <Button variant="outline" size="sm" className="h-8 rounded-r-none" onClick={autoFormat}>
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              Auto-format
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-l-none border-l-0 px-2"
                  aria-label="Layout settings"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-60 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-muted-foreground">Direction</Label>
                  <Select
                    value={layout.direction}
                    onValueChange={(v) =>
                      setLayout((p) => ({ ...p, direction: v as 'TB' | 'LR' }))
                    }
                  >
                    <SelectTrigger className="h-8 w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="TB">Top → bottom</SelectItem>
                      <SelectItem value="LR">Left → right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <NumberSetting
                  label="Node spacing"
                  value={layout.nodeSpacing}
                  onChange={(v) => setLayout((p) => ({ ...p, nodeSpacing: v }))}
                />
                <NumberSetting
                  label="Rank spacing"
                  value={layout.rankSpacing}
                  onChange={(v) => setLayout((p) => ({ ...p, rankSpacing: v }))}
                />
                {filters.softClones && (
                  <NumberSetting
                    label="Hub clone threshold"
                    value={filters.softCloneThreshold}
                    min={1}
                    max={20}
                    step={1}
                    onChange={(v) => setFilter('softCloneThreshold', v)}
                  />
                )}
                <Button size="sm" className="w-full" onClick={autoFormat}>
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                  Re-apply layout
                </Button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <RelationshipGraph
            focusId={focusId}
            filters={filters}
            relationFilter={relationFilter}
            direction={layout.direction}
            nodeSpacing={layout.nodeSpacing}
            rankSpacing={layout.rankSpacing}
            layoutNonce={layoutNonce}
            onSelect={handleSelect}
          />
        </div>
        {focusId && (
          <GraphDetailPanel
            focusId={focusId}
            activeFilter={relationFilter}
            onFilter={setRelationFilter}
            onClose={closePanel}
            onOpenFull={openFull}
          />
        )}
      </div>
    </div>
  )
}

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <Label
        htmlFor={id}
        className={disabled ? 'text-muted-foreground/50' : 'text-muted-foreground'}
      >
        {label}
      </Label>
    </div>
  )
}

function NumberSetting({
  label,
  value,
  onChange,
  min = 10,
  max = 400,
  step = 10,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-muted-foreground">{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
        className="h-8 w-[88px]"
      />
    </div>
  )
}
