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
- `media.ts` (#423): the media blocks' shared rules: which blocks hold media and the picker
  kind each takes (`MEDIA_BLOCK_KINDS`), the upload `accept` lists, the file label's rules, the
  "PDF · 240 KB" line, the icons, and `isMediaMissing` (the API's `media_missing`: a deleted
  media, not a failed lookup).
- `layoutBlocks.ts` (#426): the rules of columns, buttons and the spacer (layouts, widths, the
  button href check `normalizeButtonHref`, the spacer's theme steps). `buttonHrefVectors.json` is
  shared with the API.
- `coverMedia.ts` (#427): cover and media & text: the overlay, alt text, the focal point's rules
  and keys, and the node ⇄ stored attrs. `coverMediaVectors.json` is shared with the API.
- `embeds.ts` (#425): the embed providers: ref patterns, player addresses and their iframe
  attributes, frame hosts (the CSPs), and the title's rules.
- `nesting.ts` (#414): **the nesting table** (which types are containers and what each holds),
  the shared block predicate `isBlockNode`, the content expressions, `dedupeBlockRefs`,
  `nestingIssues` (the structural checks `validateBlockDoc` runs) and `blocksInReadingOrder`.
  `nestingVectors.json` is shared with the API's tests.
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
- **bullet_list** / **ordered_list**: lists whose `children` are list item ids
- **list_item**
- **group** (#414): a container: `children` are its blocks (flow and details, #421: no
  group, no list item), `attrs.style` `tinted` (absent: none) and `attrs.align` `wide`/`full` (absent:
  content)
- **details** (#421): a container: `children` are its blocks (flow only: no details or
  group in it), its summary a part, not a block: `attrs.summary` runs (bold, italic, link,
  like a caption's) and `attrs.text` their text (absent when empty), `attrs.open: true`
  ("Open by default"; absent: closed). A group may hold a details
- **gallery** (#424): a container: `children` are `image` blocks (none is fine), each with its
  own alt, caption and media id; `attrs.columns` 2–4 (`GALLERY_COLUMNS`, always written) and
  `attrs.caption` (runs like an image's; absent: none), a part, not a block. Top level only
- **callout** (#419): flow; its paragraphs in `pm` (node `callout`, `paragraph+`), and
  `attrs.tone` `info`/`success`/`warning`/`danger` (`CALLOUT_TONES`, always written; absent or
  unknown reads as info), never in `pm`
- **pull_quote** (#419): flow; a textblock (node `pullQuote`, `inline*`) with `attrs.cite` by
  the quote's rules (`normalizeCite`, `CITE_MAX_LENGTH`), never in `pm`
- **todo_list** / **todo_item** (#419): a third list type (`LIST_ITEMS`): `children` are its
  `todo_item`s (node `taskItem`, TipTap's TaskItem, `paragraph+`), each a block with its id and
  `attrs.checked` (a boolean, always written), never in `pm`. No attrs on the list itself
- **table** (#420): a flow block (no `children`). `attrs.pm` is the `table` node: `tableRow`s
  of `tableCell`s, each cell `paragraph+`, its only attrs `colspan`/`rowspan` (integers
  2..`TABLE_MAX_SPAN`, absent when 1); every stored cell is a `tableCell`, and
  `attrs.headerRow: true` (absent: none) makes the first row the header row. `attrs.caption`
  is runs like an image's, `attrs.text` the cells' text. `tableRows(pm)` reads it as the
  renderer does. Rules: `../collaboration/CLAUDE.md` (blockBridge notes, Table).
- **video** / **audio** (#423): flow; `attrs.mediaId` (a positive integer, the media library
  item; absent: no file yet) and `attrs.caption` (runs, like an image's). No `src`: the file's URL,
  type and size are the media library's (`media.ts`; the public page reads the API's `media` map,
  so files are served only from `/uploads`)
- **embed** (#425, `embeds.ts`): flow; `attrs.provider` (one of `EMBED_PROVIDERS`), `attrs.ref` (that
  provider's id, checked against its pattern; absent: no link yet), `attrs.title` (plain text, at
  most `EMBED_TITLE_MAX_LENGTH` code points, never HTML; absent: the provider's name) and
  `attrs.caption` (runs, like an image's). Never HTML from a provider or a pasted URL.
  `embedVectors.json` is shared with the API
- **file** (#423): flow; `attrs.mediaId` and `attrs.label`, the link text (plain, by
  `normalizeFileLabel`: trimmed, at most `FILE_LABEL_MAX_LENGTH` code points; absent: the file's
  name)
- **columns** / **column** (#426): containers. `columns` holds 2–4 `column` blocks (`attrs.layout`
  `50-50`/`33-67`/`67-33`, absent: equal, applying only with exactly two; `attrs.align` `wide`/`full`,
  absent: content), at the top or in a group. A `column` only exists in a `columns` and holds flow and
  details, never a group (the table stays acyclic)
- **buttons** (#426): flow, its buttons in `attrs.pm` (a `buttons` node of `button` nodes, each
  `href` when it has one, `variant` when `secondary`, its label as one text run; parts, no ids),
  `attrs.text` the labels, `attrs.align` `center` (absent: left)
- **footnotes** / **footnote** (#422, `footnotes.ts`): `footnotes` is a container of `footnote` blocks, at most one per doc, the last of
  `blocks_order`, no attrs. A `footnote` is one note: `attrs.pm` (a `footnote` node, rich inline text) and `attrs.text`. Its block id is what
  its references point at. Numbers aren't stored anywhere
- **spacer** (#426): flow, `attrs.size` a step of the theme's spacing scale: `5`, `7`, `8`, `9`
  (`SPACER_STEPS`), never pixels
- **cover** (#427): a container at the top level: `children` are flow blocks on top of one image.
  `attrs.mediaId`, `attrs.alt` (absent: none), `attrs.decorative` (always written; absent reads as
  true), `attrs.focal` `{x, y}` whole percent (absent: the media's own), `attrs.overlay` 0–80 in
  steps of 5 (always written), `attrs.align` `wide`/`full` (absent: content). No `src`
- **media_text** (#427): a container at the top level or in a group: `children` are flow blocks
  and details beside one image. `mediaId`, `alt`, `decorative` (absent reads as false), `focal`, and
  `attrs.position` `right` (absent: left)
- Theme blocks: unknown types keep their ProseMirror JSON in `attrs.pm` and round-trip
  unchanged.

## Inline nodes (#320, `inlineNodes.ts`)

Not block types: inline atoms inside a text block's `pm` (no block version changed).

- **`mention`** `{userId, label}`: a member's id and their name when inserted (the editor shows
  their current name; the public API replaces the attrs with `{label: <current name>}`).
- **`contentLink`** `{postId, label}`: the target post's id and the link text. No URL is stored:
  the public API adds `href` (the target's current URL) only while it is published.
- **`dateChip`** `{date, time, reminder}`: a calendar day (YYYY-MM-DD), an optional HH:MM in the
  site's zone, and whether its author asked to be reminded (a reminder always has a time,
  09:00 by default). Formatted when rendered; the reminder's owner is the API's, never stored.

- **`footnoteRef`** `{footnoteId}` (#422, `footnotes.ts`): the id of its note, nothing else. Its number is the order of the references.

Every value goes through the normalizers here; `inlineNodeVectors.json` is shared with the
API's sanitizer tests. An invalid mention or link is its label as text, an invalid chip is
dropped.

## Block structure

```typescript
interface Block {
  id: BlockID // Stable, unique identifier
  type: BlockType // One of the supported types
  version: 1 // For future migration support
  attrs: BlockAttrs // Type-specific attributes
  children?: BlockID[] // For lists (their items) and containers (their blocks)
}
```

- **Nesting (#414):** a container's children are full blocks in the flat `blocks` map,
  referenced by id. Each block is referenced at most once (by `blocks_order` or one
  `children`), never in a cycle, and only with the types and counts the table in
  `nesting.ts` allows. A core block that is neither a list nor a container has no
  `children`. Repeats within one list are removed before the checks (`dedupeBlockRefs`, the
  API's `deduplicateBlocks`). An unreferenced block is allowed (restores pass through it).

- **Block colour (#356):** paragraph, heading, blockquote, bullet_list and ordered_list
  may have `attrs.blockColor`, one of `BLOCK_COLORS` (a theme token for tinted text, or
  `<token>-background` for a tinted block). Never a free colour, never in `pm`, absent when
  untinted; the bridge, the validator and the API sanitizer drop anything else. Rules:
  `../collaboration/CLAUDE.md` (blockBridge notes).
- **Block anchors (#356):** the public page gives every top-level block the element id
  `blockAnchorId(id)` = `b-<id>` (only for ids of 10–128 letters, digits, `-`, `_`), the
  target of the editor's "Copy link to block".
- Every block keeps both its ProseMirror JSON (`pm`) and plain text (`text`).
- IDs survive content transforms (heading → paragraph, etc.).
- Lists are containers: the list block holds its items' ids in order.
