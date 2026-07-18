import { createContext, useContext } from 'react'

/**
 * Holds the "group key" of the node currently hovered (for the relationship
 * graph, an entity's real id). Lets every instance of that entity — including
 * soft clones — highlight together, without changing the node data array (which
 * would retrigger dagre layout). null when nothing is hovered.
 */
export const GraphHoverContext = createContext<string | null>(null)

export const useGraphHover = () => useContext(GraphHoverContext)
