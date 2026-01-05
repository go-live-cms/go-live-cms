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
export type BlockComponent<TAttrs = any> = React.FC<BlockComponentProps>

/**
 * Block category for organizing blocks in the editor
 */
export type BlockCategory = "text" | "media" | "design" | "widgets" | "embed" | "layout"

/**
 * Attribute type definitions
 */
export type AttributeType = "string" | "number" | "boolean" | "object" | "array"

/**
 * Attribute schema definition
 */
export interface AttributeSchema<T = any> {
  type: AttributeType
  default?: T
  enum?: T[]
  required?: boolean
}

/**
 * Block attributes schema
 */
export type BlockAttributeSchema<TAttrs = any> = {
  [K in keyof TAttrs]: AttributeSchema<TAttrs[K]>
}

/**
 * Block capabilities/supports configuration
 */
export interface BlockSupports {
  /** Text alignment options */
  align?: boolean | ("left" | "center" | "right" | "justify")[]
  /** Custom anchor ID */
  anchor?: boolean
  /** Custom CSS class */
  customClassName?: boolean
  /** Spacing controls */
  spacing?: {
    margin?: boolean
    padding?: boolean
  }
  /** Typography controls */
  typography?: {
    fontSize?: boolean
    lineHeight?: boolean
  }
}

/**
 * Block transform configuration
 */
export interface BlockTransform<TFromAttrs = any, TToAttrs = any> {
  type: string
  transform: (attrs: TFromAttrs) => TToAttrs
  priority?: number
}

/**
 * Block transforms (to/from other blocks)
 */
export interface BlockTransforms {
  from?: BlockTransform[]
  to?: BlockTransform[]
}

/**
 * Block variation (preset configuration)
 */
export interface BlockVariation<TAttrs = any> {
  name: string
  title: string
  description?: string
  icon?: string
  attributes?: Partial<TAttrs>
  isDefault?: boolean
}

/**
 * Configuration for a block type
 * WordPress-inspired but TypeScript-native
 */
export interface BlockConfig<TAttrs = any> {
  /** Block type identifier (matches Block.type) */
  type: string

  /** Display name for the block */
  name: string

  /** Block category */
  category: BlockCategory

  /** Description shown in block inserter */
  description?: string

  /** Icon (emoji or component) */
  icon: string

  /** Keywords for search */
  keywords?: string[]

  /** Sort priority (lower = first) */
  priority?: number

  /** Hide from block inserter */
  isPrivate?: boolean

  /** Attribute schema with types and defaults */
  attributes?: BlockAttributeSchema<TAttrs>

  /** Block capabilities */
  supports?: BlockSupports

  /** Parent block restrictions */
  parent?: string[]

  /** Allowed child blocks */
  allowedBlocks?: string[]

  /** Block transforms */
  transforms?: BlockTransforms

  /** Block variations */
  variations?: BlockVariation<TAttrs>[]

  /** Context consumed from parent */
  usesContext?: string[]

  /** Context provided to children */
  providesContext?: Record<string, string>

  /** The component that renders this block */
  component: BlockComponent<TAttrs>

  /** Whether this block can have children */
  hasChildren?: boolean

  /** Example for preview */
  example?: {
    attributes?: Partial<TAttrs>
  }

  /** Custom validation function */
  validate?: (attrs: TAttrs) => boolean
}
