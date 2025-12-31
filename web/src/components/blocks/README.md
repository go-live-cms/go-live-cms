# Block System Architecture

WordPress-style block system with TypeScript-native auto-discovery.

## Overview

This block system uses a folder-based architecture where each block lives in its own directory with automatic registration via Vite glob imports. No manual registry updates needed!

## Folder Structure

```
blocks/
├── paragraph/
│   ├── index.ts              # Block configuration
│   └── ParagraphBlock.tsx    # Component implementation
├── heading/
│   ├── index.ts
│   └── HeadingBlock.tsx
├── image/
│   ├── index.ts
│   └── ImageBlock.tsx
├── ... (other blocks)
├── utils/
│   ├── constants.ts          # Shared constants
│   └── contentRenderer.ts    # Content rendering utilities
├── types.ts                  # TypeScript types
├── registry.ts               # Auto-registration logic
└── index.ts                  # Public API
```

## Creating a New Block

### 1. Create Block Folder

```bash
mkdir blocks/my_block
```

### 2. Create Component (`MyBlock.tsx`)

```tsx
import React from "react"
import type { BlockComponentProps } from "../types"

const MyBlock: React.FC<BlockComponentProps> = ({ block, doc, renderContent, getBlockContent, renderBlock }) => {
  const attrs = block.attrs as Record<string, unknown>

  return <div>{/* Your block rendering logic */}</div>
}

export default MyBlock
```

### 3. Create Configuration (`index.ts`)

```typescript
import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import MyBlock from "./MyBlock"

const myBlockConfig: BlockConfig = {
  type: "my_block",
  name: "My Block",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Description of what this block does",
  icon: "🎨",
  keywords: ["keyword1", "keyword2"],
  priority: 100,

  supports: {
    align: true,
    anchor: true,
  },

  component: MyBlock,
  hasChildren: false,
}

export default myBlockConfig
```

### 4. That's It!

The block will be automatically discovered and registered via glob imports. No manual registry updates needed!

## Block Configuration Options

### Required Properties

- `type`: Block type identifier (matches Block.type from Block Spec v1)
- `name`: Display name
- `category`: One of: `text`, `media`, `design`, `widgets`, `embed`, `layout`
- `icon`: Icon string (emoji or icon identifier)
- `component`: React component for rendering

### Optional Properties

- `description`: Shown in block inserter
- `keywords`: Search keywords
- `priority`: Sort order (lower = first, default 100)
- `isPrivate`: Hide from block inserter
- `attributes`: Attribute schema with types and defaults
- `supports`: Block capabilities (align, anchor, spacing, typography)
- `parent`: Parent block restrictions
- `allowedBlocks`: Allowed child blocks
- `transforms`: Block transforms (to/from other blocks)
- `variations`: Block variations (presets)
- `hasChildren`: Whether block supports children
- `example`: Example for preview
- `validate`: Custom validation function

## Block Categories

```typescript
export const BLOCK_CATEGORIES = {
  TEXT: "text", // Paragraph, heading, etc.
  MEDIA: "media", // Image, video, etc.
  DESIGN: "design", // Divider, spacer, etc.
  WIDGETS: "widgets",
  EMBED: "embed",
  LAYOUT: "layout", // Lists, columns, etc.
} as const
```

## Block Supports

Control what features are available for a block:

```typescript
supports: {
  align: true,  // or ['left', 'center', 'right', 'justify']
  anchor: true,
  customClassName: true,
  spacing: {
    margin: true,
    padding: true,
  },
  typography: {
    fontSize: true,
    lineHeight: true,
  },
}
```

## Block Transforms

Define how blocks can transform to/from other block types:

```typescript
transforms: {
  from: [
    {
      type: "heading",
      transform: (attrs) => ({
        text: attrs.text,
        pm: attrs.pm,
      }),
    },
  ],
  to: [
    {
      type: "heading",
      transform: (attrs) => ({
        text: attrs.text,
        pm: attrs.pm,
        level: 2,
      }),
    },
  ],
}
```

## Block Variations

Provide preset configurations:

```typescript
variations: [
  {
    name: "default",
    title: "Default",
    description: "Default paragraph",
    isDefault: true,
    attributes: {},
  },
  {
    name: "lead",
    title: "Lead Paragraph",
    description: "Large introductory text",
    attributes: {
      className: "lead",
    },
  },
]
```

## Component Props

Every block component receives the same props:

```typescript
interface BlockComponentProps {
  block: Block // The block data from BlockDocV1
  doc: BlockDocV1 // Full document context
  renderContent: (content: PMNode[] | undefined) => React.ReactNode
  getBlockContent: (block: Block) => React.ReactNode
  renderBlock: (blockId: string) => React.ReactElement | null
}
```

## Registry API

The registry is automatically populated via glob imports:

```typescript
import { blockRegistry } from "./blocks/registry"

// Get block config
const config = blockRegistry.get("paragraph")

// Get block component
const Component = blockRegistry.getComponent("paragraph")

// Check if registered
const exists = blockRegistry.has("paragraph")

// Get all blocks
const allBlocks = blockRegistry.getAll()

// Get all type names
const types = blockRegistry.getTypes()
```

## Auto-Registration

Blocks are automatically registered using Vite's glob import:

```typescript
const blockModules = import.meta.glob<{ default: BlockConfig }>("./*/index.ts", {
  eager: true,
})

Object.values(blockModules).forEach((module) => {
  blockRegistry.register(module.default)
})
```

This scans all folders in `blocks/` and loads their `index.ts` file, registering the default export.

## Type Safety

All types are fully TypeScript-native:

- `BlockConfig<TAttrs>` - Generic block configuration
- `BlockComponentProps` - Standard component props
- `BlockCategory` - Available categories
- `BlockSupports` - Capability flags
- `BlockTransform` - Transform definitions
- `BlockVariation` - Variation presets

No JSON schemas needed - everything has full IntelliSense!

## Shared Constants

Use constants from `utils/constants.ts` for consistency:

```typescript
import { BLOCK_CATEGORIES, TEXT_ALIGN_OPTIONS, HEADING_LEVELS } from "../utils/constants"
```

## Best Practices

1. **One block per folder** - Keep blocks isolated
2. **Default export config** - Always export config as default from `index.ts`
3. **Type your attrs** - Use `as Record<string, unknown>` or define proper types
4. **Use shared constants** - Don't duplicate values
5. **Document your block** - Add clear description and keywords
6. **Set appropriate priority** - Control insertion order
7. **Define transforms** - Enable easy block conversion
8. **Add variations** - Provide useful presets

## Migration from Old System

The old manual registration system has been removed. If you have custom blocks:

1. Create a folder in `blocks/` with your block name
2. Move your component to `{BlockName}.tsx`
3. Create `index.ts` with the config
4. Remove any manual registry calls
5. The block will auto-register!
