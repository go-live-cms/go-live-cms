# Block Spec v1

The stored, editor-independent format of a post's body: `posts.block_doc` (the working
copy), `post_versions` (published snapshots) and what the public site renders
(`src/components/blocks/`). The editor itself works on ProseMirror inside a Yjs doc; the
collab server (`web/collab-server/`) converts between the two. See
`../collaboration/CLAUDE.md` before changing anything here.

## Files

- `index.ts`: the TypeScript types (`BlockDocV1`, `Block`, the per-type attrs) and the Zod
  validators (`validateBlockDoc`), which the collab server's store runs before writing
  `block_doc` (#214).
- `../collaboration/blockBridge.ts`: `pmToBlockDoc` / `blockDocToPM(WithReport)`, the
  ProseMirror ⇄ Block Spec conversion, with dropped-block reporting (#213).
- `../collaboration/fragmentBridge.ts`: the same conversion straight to and from the Yjs
  `"default"` fragment, with no editor, for the collab server's seed and store.
- `../../components/editor/extensions/BlockIdExtension.ts`: gives every top-level node and
  list item a stable, unique `data-block-id`, which becomes the block's `id`.

## Data flow

```
TipTap editor ⇄ Yjs "default" fragment ⇄ collab server
                                          ├─ seed:  block_doc → fragment (onLoadDocument)
                                          └─ store: fragment → block_doc (onStoreDocument)
posts.block_doc → publish → post_versions → public site (SSR)
```

## Block types

- **paragraph**: text with inline formatting
- **heading**: levels 1–6
- **blockquote**
- **code_block**: code with a language
- **divider**: horizontal rule
- **image**: media library image (`mediaId` is a number)
- **bullet_list** / **ordered_list**: containers whose `children` are list item ids
- **list_item**
- Theme blocks: unknown types keep their ProseMirror JSON in `attrs.pm` and round-trip
  unchanged.

## Block structure

```typescript
interface Block {
  id: BlockID // Stable, unique identifier
  type: BlockType // One of the supported types
  version: 1 // For future migration support
  attrs: BlockAttrs // Type-specific attributes
  children?: BlockID[] // For containers (lists)
}
```

- Every block keeps both its ProseMirror JSON (`pm`) and plain text (`text`).
- IDs survive content transforms (heading → paragraph, etc.).
- Lists are containers: the list block holds its items' ids in order.
