import type React from "react"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"

/**
 * ProseMirror content node type
 * Used for inline content with marks (bold, italic, links, etc.)
 */
export interface PMNode {
  type: string
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  content?: PMNode[]
  attrs?: Record<string, unknown>
}

/**
 * WordPress-style shared props interface for all block components
 * Every block receives the same props shape for consistency
 */
export interface BlockComponentProps {
  /** The block data from the BlockDocV1 */
  block: Block
  /** Full document context (for accessing children, etc.) */
  doc: BlockDocV1
  /** Function to render nested content with marks */
  renderContent: (content: PMNode[] | undefined) => React.ReactNode
  /** Function to get block content from PM data or fallback */
  getBlockContent: (block: Block) => React.ReactNode
  /** Function to render a child block by ID */
  renderBlock: (blockId: string) => React.ReactElement | null
}

/**
 * Block component type - a React functional component with our props
 */
export type BlockComponent = React.FC<BlockComponentProps>

/**
 * Configuration for a block type
 * Used by the registry to manage block rendering
 */
export interface BlockConfig {
  /** Block type identifier (matches Block.type) */
  type: string
  /** Display name for the block (for future editor UI) */
  name: string
  /** The component that renders this block */
  component: BlockComponent
  /** Whether this block can have children */
  hasChildren?: boolean
  /** Optional description */
  description?: string
}
