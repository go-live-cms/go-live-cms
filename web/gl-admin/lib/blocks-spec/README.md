# Block Spec v1 Phase A Implementation

## Overview

This implementation adds **Block Spec v1** as a mirror source of truth for the TipTap editor content. Phase A maintains the existing TipTap collaboration while mirroring every change to the Block Spec format stored in Yjs.

## What's Implemented

### 1. Block Spec v1 Types (`lib/blocks-spec/index.ts`)

- **Authoritative TypeScript types** for all block types
- **Zod validators** for runtime validation
- **BlockDocV1 interface** as the canonical document format

### 2. Yjs Document Management (`lib/collaboration/BlockDocManager.ts`)

- **BlockDocManager class** for atomic operations on block documents
- **CRUD operations** for individual blocks
- **Document-level operations** (initialize, get/set complete docs)
- **Change subscriptions** for real-time updates

### 3. ProseMirror ↔ Block Bridge (`lib/collaboration/blockBridge.ts`)

- **pmToBlockDoc()** - Convert ProseMirror doc to Block Spec v1
- **blockDocToPM()** - Convert Block Spec v1 back to ProseMirror
- **ensureBlockId()** - Stable ID generation for blocks
- **Bi-directional conversion** preserving content fidelity

### 4. Block ID Stability (`components/editor/extensions/BlockIdExtension.ts`)

- **TipTap extension** ensuring all top-level nodes have stable `data-block-id` attributes
- **Automatic ID generation** for new nodes
- **ID preservation** across document transforms

### 5. Editor Integration (`components/editor/Editor.tsx`)

- **Mirror functionality** in editor's onUpdate handler
- **Real-time sync** from ProseMirror → Block Spec v1 → Yjs
- **Debug utilities** for development testing

## Architecture

```
User Types in TipTap Editor
         ↓
ProseMirror Document (existing collaboration)
         ↓ (Mirror - Phase A)
Block Spec v1 Document
         ↓
Yjs Document Storage
         ↓ (Future phases)
API Persistence & SSR
```

## Block Types Supported

- **paragraph** - Standard text blocks with inline formatting
- **heading** - Levels 1-3 with text content
- **blockquote** - Quote blocks
- **code_block** - Code with syntax highlighting
- **divider** - Horizontal rules
- **image** - Images with media library integration
- **bullet_list** / **ordered_list** - Lists with children
- **list_item** - Individual list items

## Block Structure

```typescript
interface Block {
  id: BlockID // Stable, unique identifier
  type: BlockType // One of the supported types
  version: 1 // For future migration support
  attrs: BlockAttrs // Type-specific attributes
  children?: BlockID[] // For containers (lists)
}
```

## Key Features

### 1. **Stable Block IDs**

- Every top-level block gets a unique, persistent ID
- IDs survive content transforms (heading → paragraph, etc.)
- Generated via crypto.randomUUID() or fallback

### 2. **Content Preservation**

- **Dual storage**: Both ProseMirror JSON (`pm`) and plain text (`text`)
- **Future-proof**: Can migrate away from ProseMirror internals
- **Rich content**: Preserves marks, links, and formatting

### 3. **List Handling**

- Lists are **first-class containers** with child block IDs
- Enables **block-level operations** (drag/drop, indent/outdent)
- **Clean hierarchy** for SSR and API consumption

### 4. **Conflict Resolution**

- **Block-level granularity** reduces merge conflicts
- **Yjs CRDT** handles concurrent edits at block level
- **Atomic operations** via BlockDocManager

### 5. **Development Testing**

- **Console utilities**: `testBlockSpec()` for manual testing
- **Live inspection**: `window.blockDocManager` in dev mode
- **Change logging**: See mirrored updates in console

## Testing

### Manual Testing (Browser Console)

1. Start dev server: `npm run dev`
2. Open a post with editor (collaboration enabled)
3. Open browser console
4. Run: `testBlockSpec()`

### What to Test

- ✅ Type content → see BlockDoc updates in console
- ✅ Create headings → verify level preservation
- ✅ Add lists → check parent/child structure
- ✅ Insert images → confirm media attributes
- ✅ Block operations → test CRUD functions

## Next Steps (Phase B & C)

### Phase B - Read from BlockDoc

- Load editor content from BlockDoc instead of PM collaboration
- Two-way sync: BlockDoc ↔ TipTap

### Phase C - Native Block Collaboration

- Replace PM collaboration with block-level Yjs bindings
- Custom TipTap extensions for direct block manipulation

## Migration Path

### For API/SSR (Immediate)

- Can start reading from BlockDoc format today
- Stable, versioned contract independent of editor internals
- Rich semantic structure for rendering

### For Editor (Gradual)

- Phase A: Mirror mode (✅ Complete)
- Phase B: Bi-directional sync
- Phase C: Native block operations

## Files Changed

```
web/gl-admin/
├── lib/blocks-spec/index.ts                    # Types & validators
├── lib/collaboration/BlockDocManager.ts        # Yjs operations
├── lib/collaboration/blockBridge.ts            # PM ↔ Block conversion
├── lib/test/blockSpecTest.ts                   # Dev testing utilities
├── components/editor/
│   ├── extensions/BlockIdExtension.ts          # ID stability
│   ├── utils/extensions.ts                     # Added BlockIdExtension
│   └── Editor.tsx                              # Mirror integration
```

This implementation provides a **solid foundation** for Block Spec v1 while maintaining **zero disruption** to existing functionality.
