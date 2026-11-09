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
  anchorId?: string // `b-<block id>` on top-level blocks (#356): the root element's id
}
```

- **Containers (#414):** a container (`group/`) renders its children with
  `renderBlock(childId)`, so every block type works inside one at any depth. The helpers that
  read the doc walk the tree in reading order (`blocksInReadingOrder`): `headingAnchors` (a
  heading in a group gets an anchor), `isFirstImageBlock` (the first image at any depth loads
  eagerly) and `seo.ts`'s `firstParagraphText`. A container may re-provide
  `ImageSizesContext` for its children when they render narrower. Group's markup:
  `div.group` plus `is-tinted`, `alignwide` / `alignfull`.
- **Callout, pull quote, to-do list (#419, the canvas's "Published · text"):** `callout/` is
  `div.callout.is-<tone>` with `role="note"`, the tone's icon (`aria-hidden`, the same path as
  the editor's, `CALLOUT_TONE_ICONS`) and `.callout-body` with one `<p>` per paragraph, the
  first starting with `<span class="sr-only">Warning: </span>`; an unknown tone renders as
  info. `pull_quote/` is `figure.pullquote > blockquote > p` plus the citation as
  `<figcaption>` (plain text). `todo_list/` is `ul.todo-list > li.todo-item(.is-checked)` with a
  **disabled** checkbox (readers can't toggle it, it isn't a tab stop) labelled by the item's
  text (`aria-labelledby` = `todo-<item id>`, or `aria-label` for an id that isn't HTML-safe).
  The default theme styles them (`themes/default/styles/theme.css`).
- **Details (#421, `details/`):** the browser's own `<details id="b-<id>" [open]>` (only
  with `attrs.open: true`), its `<summary>` first (the runs, caption marks only; an empty one
  is an empty `<summary>`, so the browser shows no "Details" label of its own), then its
  blocks through `renderBlock`. No script: the browser opens and closes it (a click, ↵ or Space
  on the summary). Nothing renders when none of its blocks does. The default theme styles
  `details`/`summary` (rules, a chevron that turns).
- **Gallery (#424, `gallery/`):** `figure.gallery-block > ul.gallery[style="--cols:N"] > li`, one
  per image through `renderBlock` (the ordinary image block: its own alt, caption, focal point,
  `srcset`), then the caption as the figure's `figcaption`. `sizes` comes from the column count
  (`gallerySizes`, through `ImageSizesContext`); `ImageInGalleryContext` makes an image ignore its
  own width. An image whose media was deleted is left out with its caption; a gallery with no image
  left to show is left out entirely, caption included. The theme lays the grid out
  (`themes/README.md`).
- **Table (#420, `table/`):** `figure.table-block > div.table-scroll[role=region][tabindex=0]
  [aria-labelledby=<caption id>] > table`, then `figcaption#b-<id>-caption` (the id comes from
  the block id, so a table in a group has one too; without a caption the region is
  `aria-label="Table"`). With `headerRow` the first row is a `<thead>` of `<th scope="col">`
  (`colgroup` when it spans columns; a header cell never spans rows). Cells come from
  `tableRows` (paragraphs only, spans clamped) and render like a list item's text. The theme
  makes `.table-scroll` scroll sideways (`themes/README.md`).
- **Columns, buttons, spacer (#426, "Published · layout"):** `columns/` is `div.columns` of
  `div.column` (`column/`, through `renderBlock`), `is-3-columns` / `is-4-columns` past two,
  `is-33-67` / `is-67-33` for the splits, `alignwide` / `alignfull` as on a group; each column gets
  its own `ImageSizesContext` (`columnImageSizes`). `buttons/` is `div.buttons` (`is-center`) of
  `a.btn.btn-primary` / `.btn-secondary`: every href goes through `normalizeButtonHref` again, and
  a button with no link or label is left out. `spacer/` is an empty `div.spacer`, `aria-hidden`, its
  height `var(--space-<n>, <px>)` from the theme's scale.
- **Inline marks (`utils/contentRenderer.tsx`):** bold `<strong>`, italic `<em>`, underline `<u>`,
  strike `<s>`, code `<code>`, link `<a>` (`safeHref`), and since #418 highlight `<mark>` (no
  style: the theme's one colour), superscript `<sup>` and subscript `<sub>`, nested in schema
  order (a link inside a highlight). Any other mark renders its text only.
- **Video, audio, file (#423, "Published · media & embeds"):** they store only a media id, so
  they render from the `media` map the API attaches to a served doc (`utils/mediaFile.ts`
  `blockFileFor`: the entry's `media_path`, accepted only under `/uploads/`, never the block's
  attrs). `video/` and `audio/` are `figure.video-block > video` / `figure.audio-block > audio`
  with `controls`, `preload="none"` and **no autoplay**, named by the caption's text (else the
  media's name), a download link inside for a browser that can't play it, then the
  `figcaption`. `file/` is `div.file-block > span.file-icon + div.file-text (a +
  span.file-meta "PDF · 240 KB") + a.btn.btn-secondary.file-download`; both links carry
  `download` = the uploaded file's name. Nothing renders for a block with no file, a media the
  API lists in `media_missing` (deleted: left out with its caption, the image too), or one with
  no entry (the lookup failed; an image then renders from its own `src`).
- **Embeds (#425, `embed/`, "Published · media & embeds"):** `figure.embed-block > div.embed-frame` (`.is-card`
  for X, `.is-compact` for SoundCloud and Spotify) with `.embed-provider`, `p.embed-title`, the Load
  button (`[data-embed-load]`, `.btn.btn-primary`, X's `.btn-secondary`) and `.embed-note` ("Loading it
  connects to youtube.com"), then `figcaption`. **No third-party request on page load:** no iframe,
  image or provider address in the markup, only `data-embed-provider` and `data-embed-ref`.
  `/gl-embeds.js` (from `BlockRenderer`, for a post with an embed) builds the player from its own
  per-provider templates on click, adds `.is-loaded`, `role="region"` and moves focus in; X loads its
  widget then. Nothing renders for an empty block, an invalid one, or a provider the site no longer
  allows (the API empties those).
- **Mentions, content links, dates (#320, inline nodes in any text, `renderInlineNode` in
  `utils/contentRenderer.tsx`):** a mention is `<span class="gl-mention">Ana Costa</span>` (the
  member's current name from the API, never an id or email, no "@"); a content link is
  `<a class="gl-content-link" href="/post/slug">text</a>` when the API sent a site path, else
  its text alone (a draft or trashed target); a date is `<time class="gl-date"
  datetime="2026-11-12[T14:30]">` with `attrs.label` (the site's format, `labelDateChips`) or
  the default long format. Marks apply to them as to text. Themes may style the classes.
- **`anchorId`** (#356, "Copy link to block"): every top-level block's root element gets
  it as its `id`, so `/<post url>#b-<block id>` lands on it. A heading keeps its slug id
  (#351) and puts the anchor on an empty `<span class="gl-block-anchor">` at its start.
  List items and nested blocks get none.
- **Block colour** (#356): `attrs.blockColor`, a palette token, renders as the class
  `gl-color-<value>` (`utils/blockColor.ts`: anything outside the palette renders no
  class). Paragraph, heading, blockquote and both lists read it; a tinted paragraph inside
  a list item or quote renders as a `<span>` with the class. Themes style the classes
  (`themes/README.md`, "Block colours").

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
