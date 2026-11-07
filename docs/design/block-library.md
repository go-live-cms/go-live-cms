# Block library (#352): nesting, shared plumbing, build order

Status: design; the foundation (section 2, with the Group block) is built in #414. Parent issue: #352. Design canvas: "GoLive Blocks",
<https://claude.ai/artifact/F2x5Yx7DKiPs64VFsUwEpi> (board titles are quoted below as
"Board name").

This document settles what #352's "Before building" section asks for first, so the
blocks can be built one sub-issue at a time:

1. **How blocks nest** in Block Spec v1, and how nested blocks travel through the editor
   schema, the Yjs fragment, `fragmentToBlockDoc`, block id stamping, the paste
   sanitizer, the Go API and the public renderer.
2. **The shared plumbing** every block needs: the menus, inline marks, the media picker,
   nested editing, and a guard against stale editor tabs.
3. **The build order**, and what each step depends on.

It also records recommendations for the two decisions #352 leaves open (embed loading,
custom HTML enforcement); each is confirmed in its own sub-issue before code.

Read with: `web/gl-admin/lib/collaboration/CLAUDE.md` (hard rules), `web/collab-server/CLAUDE.md`,
`web/gl-admin/lib/blocks-spec/README.md`, `web/src/components/blocks/README.md`,
`web/themes/README.md` ("Custom Blocks"). The block-map Yjs schema (#315) is being
designed at the same time in `docs/design/block-map-yjs-schema.md`; section 2.12 says
where the two meet.

---

## 1. Where things stand

- Eight core blocks: paragraph, heading, bullet/ordered list, quote, code, divider,
  image. Image caption/width and quote citation (#346) are done (Block Spec v2 for image
  and blockquote).
- **Lists are the only containers.** A `bullet_list` / `ordered_list` block has
  `children` = its `list_item` ids, and each item is its own block in the flat `blocks`
  map. A list nested inside an item is **not** flattened: it stays inside that item's
  `attrs.pm` (listItem content is `paragraph block*`). `walkBlockTree`,
  `restoreDroppedBlocks` and `DroppedBlock.parentId` already speak "a block with
  children", but `blockDocToPMWithReport` and `pmToBlockDoc` only know lists.
- **Theme blocks (#376) are one node each**, with any child content inside their `pm`.
  Their content expression may name core groups (`block+`), so a theme block can already
  hold blocks, but those blocks have no ids and are invisible to everything that walks
  the `blocks` map.
- Block ids (#238) are stamped on top-level nodes and on list items whose parent is a
  list. The same rule is written three times: `BlockIdExtension`, `stampFragmentBlockIds`
  and `pmToBlockDoc`.
- The API walks the `blocks` map flatly for sanitizing (`doc.sanitize`) and for media
  attachment (`blockDocMediaIDs`), but **`contentMediaUses` (the `post_media` sync, "Used
  in") walks `blocks_order` only**: an image inside any container would not be recorded.
  The search text function (migration 000024) already recurses through `children`.
- The public renderer passes `renderBlock(childId)` to every component, so a component
  can render children by id; only the list components use children today.
- The slash menu has two groups ("Basic blocks", "Media"), matches title, description and
  aliases, and shows at most 10 results. There is no + menu; the gutter has a drag handle
  only.

---

## 2. Nesting in Block Spec v1

### 2.1 Decision: containers hold child blocks by id, like lists

Columns, column, group, cover, media & text, details, gallery and footnotes are
**containers**: a block whose `children` is an ordered list of block ids, each child a
full block in the doc's flat `blocks` map. This is the representation lists already use,
generalized. Nothing about it is new to Block Spec v1, so `doc_version` stays 1; each
new container type starts at `version: 1`.

```jsonc
{
  "doc_version": 1,
  "blocks_order": ["b-cols"],
  "blocks": {
    "b-cols":  { "id": "b-cols", "type": "columns", "version": 1,
                 "attrs": { "layout": "33-67", "align": "wide" },
                 "children": ["b-col-1", "b-col-2"] },
    "b-col-1": { "id": "b-col-1", "type": "column", "version": 1, "attrs": {},
                 "children": ["b-img"] },
    "b-col-2": { "id": "b-col-2", "type": "column", "version": 1, "attrs": {},
                 "children": ["b-h", "b-p"] },
    "b-img":   { "id": "b-img", "type": "image", "version": 2, "attrs": { "mediaId": 12, "alt": "…" } },
    "b-h":     { "id": "b-h", "type": "heading", "version": 1, "attrs": { "level": 3, "pm": { … } } },
    "b-p":     { "id": "b-p", "type": "paragraph", "version": 1, "attrs": { "pm": { … } } }
  }
}
```

Why not keep children inside the container's `pm`, as nested lists and theme blocks do:

| Children by id (chosen) | Children inside `pm` (rejected) |
|---|---|
| Every nested block has a stable id: block comments (#192), the History diff (#355), dropped-block anchors and #315 all key on it. | Nested blocks have no ids. |
| The Go sanitizer's per-type rules (image `src`, caption marks, `align`, every new type's allowlist) apply to a nested image exactly as to a top-level one, because the sanitizer walks the flat map. | Only the generic pm walk reaches them, so per-type rules would need a second, recursive implementation. |
| Media sync, media attachment and search see nested media and text. | They don't. |
| One renderer component per type, reused at any depth through `renderBlock`. | The renderer would need to render arbitrary pm nodes as blocks. |
| A child that can't be built is dropped and kept on its own (#213), not with its whole container. | One bad child costs the container. |

Out of scope, unchanged: lists nested inside a list item stay in that item's `pm`
(flattening them is a separate change with its own migration), and theme blocks stay
single nodes (2.11).

### 2.2 The nesting table

One table in `web/gl-admin/lib/blocks-spec/nesting.ts` says which block types are
containers and what each may hold. Everything else is derived from it: the TipTap content
expressions, `validateBlockDoc`, the Go checks (through a shared vectors file, like
`themeBlockVectors.json`), the menus (what to offer inside a slot) and the bridge.

Two groups:

- **`flow`**: every block that holds no blocks: paragraph, heading, lists, quote, pull
  quote, callout, code, table, to-do list, image, video, audio, file, embed, buttons,
  divider, spacer, custom HTML. (Lists count as flow: their items are their own business,
  as today.)
- **containers**, each with the child types it accepts:

| Container (Block Spec type) | Children | Count | Holds as attrs / non-block parts |
|---|---|---|---|
| `group` | flow, `details`, `columns`, `media_text` | 1+ | `style`: `none`/`tinted`; `align` |
| `columns` | `column` only | 2–4 | `layout` (`50-50`, `33-67`, `67-33`, `equal`), `align` (`content`/`wide`/`full`) |
| `column` | flow, `details` | 1+ | none (widths come from the parent's `layout`) |
| `cover` | flow | 1+ | `mediaId`, `alt`, `decorative`, `focal`, `overlay`, `align` |
| `media_text` | flow, `details` | 1+ | `mediaId`, `alt`, `decorative`, `focal`, `position` (`left`/`right`) |
| `details` | flow | 1+ | `open` (default false); **summary** as a child node, see 2.4 |
| `gallery` | `image` only | 0+ (empty is an editor state, not rendered) | `columns` (2–4); caption as a child node |
| `footnotes` | `footnote` only | 1+ | at most one per doc, see 2.9 |

Top level (`blocks_order`, the doc's `block+`) accepts flow and every container except
`column` and `footnote`, which only exist inside their parent.

**The table is acyclic on purpose.** No container can hold itself, directly or through
another, so nesting depth is bounded by the schema (the deepest path is group → columns
→ column → details → flow) and no depth counter is needed anywhere. The canvas's "A
tinted group holding three columns" ("Editor · columns, group, buttons, spacer") is
allowed; a group inside a column is not. Allowing it later means breaking a cycle
somewhere else (or adding a depth rule); that is a deliberate table change, not a bug fix.

### 2.3 Validation (`validateBlockDoc`, Go `prepareForStore`)

Today's checks stay. New ones, identical in Zod and Go, pinned by a shared vectors file
(`blocks-spec/nestingVectors.json`) that both test suites read:

1. Every id in `blocks_order` or any `children` exists in `blocks` (the API checks
   `blocks_order` today; children are added).
2. **Each block is referenced at most once** across `blocks_order` and all `children`.
   Two parents sharing a child would render it twice and make moves ambiguous. Repeats
   *within one list* are removed first, not refused: the API already runs
   `deduplicateBlocksOrder` before its checks because such docs exist, so it dedups each
   `children` array the same way, and the collab store runs the same step before
   `validateBlockDoc`. Only an id under two different parents (or under a parent and at
   the top) is an error, so no stored post starts failing its stores.
3. No cycles (implied by 2 plus the acyclic table, but checked directly, as the bridge's
   list cycle guard does now).
4. A container's children are of the types and in the count the table allows; a
   non-container has no `children`, except the list types (bullet, ordered and to-do
   lists), whose children are their items, as today.
5. An unreferenced block in `blocks` is not an error (restores and dropped blocks pass
   through such states); renderers ignore it.

A doc that fails is refused by the store as today (`collab_store_invalid`: Yjs state
stored, `block_doc` kept at its last valid version). The bridge is what keeps that from
happening in practice (2.5): it never produces a doc that breaks these rules.

### 2.4 The ProseMirror schema

- Node names are camelCase like the existing ones (`columns`, `column`, `group`,
  `cover`, `mediaText`, `details`, `gallery`, `footnotes`, `footnote`); Block Spec types
  are snake_case. The mapping lives next to the nesting table.
- Content expressions are generated from the table: `group` → `(flow | details | columns
  | mediaText)+`, `columns` → `column{2,4}`, `column` → `(flow | details)+`, and so on.
  As built (#414), `flow` is TipTap's existing `block` group: **no container is in it**, so
  `block` holds exactly the nodes that hold no blocks (core flow nodes, theme blocks,
  stand-ins), and a quote, a list item or a theme block (which name `block`) can never hold a
  container. The doc's content is generated too (`(block | group | …)+`, `GroupDocument`, in
  place of StarterKit's `block+`). No StarterKit node had to be re-declared for a new group.
  Containers are `isolating` (Backspace at the start of a column doesn't merge it into the
  previous one) and `defining`.
- **Parts of a block that aren't blocks are child nodes without ids**, the pattern
  #346 set with `imageCaption`: the details summary (`detailsSummary`, rich text, first
  child of `details`), the gallery caption, the embed caption. A child node so two people
  typing in it merge per character; in Block Spec it is an attr of its block
  (`attrs.summary`, `attrs.caption`) as text runs, like `CaptionText[]`. The bridge
  separates parts from child blocks by node type.
- If a TipTap extension wraps the children in an id-less wrapper (TipTap's Details puts
  them in `detailsContent`), the table names that wrapper as the container's **slot**:
  the bridge flattens it (its children become the container's `children`), and a node
  whose parent is a slot counts as a nested block. Prefer writing our own node without a
  wrapper when the extension doesn't fit the pinned 3.4.2 set.
- New TipTap packages (table, highlight, superscript, subscript, details if used) are
  added at exactly `3.4.2` with `overrides` entries (`web/CLAUDE.md`, "TipTap version
  pin"; `tiptapPin.test.ts` fails otherwise). Never anything that brings its own yjs
  (rule 8).
- `schema.ts`'s `schemaExtensions()` gains every new node and mark, so the collab
  server's schema and the editor's stay equal (`schema.test.ts`).

### 2.5 The bridge: `pmToBlockDoc`, `blockDocToPMWithReport`, `fragmentToBlockDoc`

`blockBridge.ts` generalizes from lists to the table:

- **PM → Block Spec (`pmToBlockDoc`)**: recursive. A container node becomes its block
  plus one block per child node (per slot child, when there is a slot), in document
  order, with `children` set; parts (summary, caption) become attrs. Duplicate and
  invalid ids are regenerated across the whole doc, as now. A container left with no
  children (only reachable through a schema-invalid node) is skipped, like a childless
  list today.
- **Block Spec → PM (`blockDocToPMWithReport`)**: `listItemsToPM` becomes
  `containerChildrenToPM`. Each child is built and `check()`ed on its own; one that can't
  be is **dropped and reported** with `parentId` = its container and `afterId` = its
  previous sibling (`DroppedBlock` already has both). The container keeps the others.
  `restoreDroppedBlocks` already restores a child under its parent at that position, and
  `walkBlockTree` already copies whole subtrees.
- **Too few children after drops**: as with lists, synthesize what the schema needs,
  with **deterministic ids** derived from the container id (`synthesizedItemId`'s rule:
  `<containerId>-<role>`, always ≥ 10 characters), so the same doc gives the same ids on
  every load and the store sees no change. A `column` gets one empty paragraph; a
  `columns` with fewer than 2 columns gets empty columns up to 2. A gallery may be
  empty (its content is `image*`): the editor shows the canvas's empty-gallery state
  ("Errors & empty states", "An empty gallery") and the renderer leaves it out, caption
  included, so nothing is synthesized or dropped for it.
- **Cycles**: `listsInProgress` becomes `containersInProgress`; the child that closes a
  cycle is dropped like any other bad child. A child referenced twice is converted at its
  first reference only and dropped at the others.
- **`fragmentToBlockDoc`** (the store) converts each top-level node on its own and falls
  back to `previous` for one it can't build. A container is one top-level node, so one
  unbuildable descendant would cost the whole container its live version. Container
  descendants get the same treatment at their level: an unbuildable child keeps its
  previous version under its parent (a `DroppedBlock` with `parentId`), not the
  container's.
- `stampBlockIds` (the old bulk helper) and any other copy of the id rule go through the
  shared predicate (2.6).

Tests: `blockBridge.nesting.test.ts` (round trips, drops at each depth, synthesized ids
stable across loads, cycles, double references) and `fragmentBridge` cases for a
container with an unbuildable child.

### 2.6 Block ids for nested blocks (#238)

One predicate, exported from `blocks-spec/nesting.ts`, used by `BlockIdExtension`,
`stampFragmentBlockIds` and `pmToBlockDoc`:

> A node is a block when its parent is the doc, a container, or a container's slot, or
> when it is a list's item (`listItem` in a bullet or ordered list, `taskItem` in a
> to-do list).

- Rule 7 stays: `BlockIdExtension` ignores sync transactions (`isChangeOrigin`), and
  only the originating client stamps; the server stamps anything still missing before a
  store.
- Duplicates are regenerated across the whole doc in document order, at every depth.
  Splitting a block copies its id; so does duplicating a container (#356's ⌘⇧D) and
  pasting one, so all three end up with fresh ids for every descendant.
- Parts (summary, captions) never get ids; they aren't blocks.
- `regenerateBlockIDs` (Go, used by duplicate and templates) already remaps `children`
  and every `data-block-id` inside a block; it needs a test with a nested doc, not a
  change.

### 2.7 The collab server (`web/collab-server`)

Nothing server-specific changes for nesting: the server converts with
`getInstalledCollabSchema()` (core schema + theme blocks), which picks up the new nodes
from `schemaExtensions()`, and its store pipeline (stamp → `fragmentToBlockDoc` →
`validateBlockDoc` → empty guard → PUT) works on the generalized bridge. What matters
is **deployment**:

- Every new node or mark type is a rule 10 hazard for open editor tabs on the previous
  bundle: y-tiptap deletes an element (or a text run with an unknown mark) it can't
  build, for every peer, and the next store persists the loss. The gate in `Editor.tsx`
  covers types present at bind time, **not** a peer inserting a new type later. This
  library adds about twenty types over a dozen deploys, so the foundation includes a
  guard: the client sends its schema fingerprint (a hash of the schema spec) in the auth
  message, and the server refuses a mismatch with a new reason (`schema-mismatch`) that
  makes the client reload. **Built in #416** (`schemaFingerprint.ts`; rule 10 in
  `web/gl-admin/lib/collaboration/CLAUDE.md` says what counts as a change). A block PR that
  ships before it reaches production still says "reload open admin tabs after deploying",
  as #346's did.
- `meta.dropped` entries with a container `parentId` need no format change.

### 2.8 Paste (#128)

`PasteSanitizer.ts` keeps its model (DOMPurify on pasted HTML, then the schema's parse
rules):

- `ALLOWED_TAGS` grows only with tags a new block or mark parses from: `mark`, `sup`,
  `sub` (marks); `details`, `summary` (details); `table` is already allowed. Media
  (`img`, `video`, `audio`, `iframe`) stays dropped by design: media is inserted from the
  library.
- **`data-pm-slice` contexts** (`SLICE_CONTEXT_TYPES`) gain the container types, with
  attrs reset to null as today, so a slice copied from inside a column recreates a column
  with default attrs and **no copied ids**. Unknown types still drop the context.
- `data-block-id` is stripped everywhere, as now, so every pasted block, at any depth,
  gets a fresh id.
- Pasting into a slot is the schema's job: content a slot doesn't accept is lifted or
  dropped by ProseMirror's fitting, never stored invalid.
- Tests: `PasteSanitizer.test.ts` cases for each new tag, a pasted slice with a container
  context, and `PasteSanitizer.collab.test.ts` for a pasted container (fresh ids on two
  peers).

### 2.9 The Go API (`api/`)

- **`sanitize`**: still walks the flat map, so nested blocks are covered. Each new type
  gets a `sanitize<Type>Attrs` with an **allowlist of attrs** (unknown attrs deleted,
  enums enforced, numbers clamped, text capped), the way `sanitizeImageAttrs` does.
  `children` is checked to be an array of strings. URLs held in **node attrs** (a
  button's `href`) need their own `isSafeURL` check: `sanitizePMNode` only checks link
  marks' `href` today.
- **`prepareForStore`**: the structural checks of 2.3, after `checkLimits` and before
  the theme block pass. Limits stay as they are: `maxBlockDocBlocks` (5000) counts nested
  blocks too, and per-block JSON depth is now small because children are separate blocks.
- **`contentMediaUses`** walks the tree (blocks_order, then children depth first, the
  search function's order) and records every media-bearing type: image, gallery images
  (they are image blocks), video, audio, file, cover, media & text. Today it reads only
  top-level images. `blockDocMediaIDs` likewise learns the new media types.
- Footnotes: at most one `footnotes` block per doc, at the top level; a `footnote` child
  whose id no `footnoteRef` in the doc points at is kept (the editor offers cleanup), not
  deleted by the API.

### 2.10 The public renderer (`web/src/components/blocks/`)

- One folder per type, as today. A container renders its children with
  `renderBlock(childId)`; nothing else is needed for depth.
- **`headingAnchors`** (and any table-of-contents caller) walks the tree, so a heading in
  a column gets an anchor.
- The other helpers that read only `blocks_order` walk the tree too:
  **`isFirstImageBlock`** (`blocks/utils/responsiveImage.ts`; the first image in reading
  order, at any depth, including a cover's or media & text's media, loads eagerly, since a
  post that opens with a cover has its hero there) and **`firstParagraphText`**
  (`src/lib/seo.ts`; the description and list excerpt fallback finds a post's first
  paragraph inside a group or column).
- `doc.media` lookups work by `mediaId` and need no walk, but **`ImageSizesContext`** is
  re-provided by `column` / `media_text` (a column's image is narrower than the text
  column, so its `sizes` must say so).
- `BlockRenderer`'s trailing-blank-paragraph trim stays top-level only.
- Missing media (#352): a block whose `mediaId` has no entry in `doc.media` because the
  media was deleted is not rendered, with its caption. The API has to tell "deleted"
  from "lookup failed" (today a failed lookup also leaves `doc.media` empty, and the image
  then renders from `src`): `attachBlockMedia` adds `media_missing: [ids]` for ids that
  don't exist, and only those are left out.
- Default theme styles (#345) for every new block, from `themes/default/README.md`'s
  tokens; `tokens.test.ts` keeps checking contrast and `var()`s.

### 2.11 Theme blocks

Theme blocks stay one node with their content in `pm` (#376's contract). To keep media
and text from hiding inside them, `collectThemeBlocks` refuses a theme block whose
content expression names a container type or a media type; `flow` itself contains media,
so a theme block may use `inline*`, `text*`, `paragraph+` and the text-only groups the
foundation defines. That narrows the contract in `themes/README.md` (`block+` is allowed
today); the only installed theme block, `theme:example/alert`, uses `inline*`. Theme
*containers* (a theme block whose children are real blocks) are
a later, separate design.

### 2.12 How this meets the block-map schema (#315)

#315 asks whether block `Y.Map`s keyed by block id should become the source of truth
(adopt), hold only per-block metadata beside the `"default"` fragment (partial), or not
be used (don't). The nesting design is chosen to be right in all three:

| #315 outcome | What it means for nesting | What this design already provides |
|---|---|---|
| **Don't adopt** | Containers are fragment nodes; the bridge flattens them on store. | This document as written. |
| **Partial** (fragment for content, maps keyed by id for comments, locks, …) | Every nested block must have a stable, unique id that survives edits and moves. | 2.6: one id predicate for every depth, server stamping, dedupe; parts never get ids, so nothing anchors to them. |
| **Adopt** (blocks as `Y.Map`s, order as `Y.Array`s) | Nesting becomes "a block map with a `children` array of ids". | That is exactly Block Spec's shape (2.1): the map representation and the stored representation coincide, so `block_doc` needs no change; only the PM binding changes. |

Constraints this puts on #315, and on this design until #315 decides:

- **Structure lives in Block Spec, not in ProseMirror.** Which types nest and how is
  the nesting table (2.2); the PM content expressions are generated from it. A map-based
  binding reads the same table.
- **No data only the PM tree can express.** Column widths are the `columns` block's
  `layout` attr, not something computed from nodes; parts (summary, captions) are attrs
  of their block in Block Spec. A per-character-merged part in a map design would be a
  `Y.XmlText` in that block's map, which #315 has to allow for (it already has to for
  paragraphs).
- **No id-less wrappers between a container and its children** in Block Spec. A slot
  (2.4) exists only on the PM side and is flattened by the bridge.
- **Moves are by id, and Yjs has no move.** Dragging a block into another column is
  "remove from one `children`, insert into another". In the fragment that is a delete
  plus an insert of a copy, so when two peers move the same block at once both inserts
  survive: the block appears twice, the two copies share a `data-block-id`, and
  `BlockIdExtension` / `stampFragmentBlockIds` give one of them a new id. The result is
  duplicated content, never lost content, and the "referenced at most once" rule (2.3)
  still holds, because the copies have different ids. Top-level drags behave this way
  today. #417 pins it with a relay test and accepts it. A map design could do better
  with a real move (one `children` entry rewritten, last writer wins), which is a point
  in favour of #315 adopting maps, not something this design depends on.

If #315 lands first and changes the id rules or how containers are bound, the foundation
issue updates 2.5–2.6 before it starts; the Block Spec shape above does not change either
way. (#315 decided **Option C**, adopt partially: the `"default"` fragment stays the only
content, ids are the anchor, and the "is this node a block" rule becomes one shared
predicate. That is 2.6 as written, so 2.5–2.6 needed no change; the predicate is
`isBlockNode` in `blocks-spec/nesting.ts`.)

---

## 3. Shared plumbing

### 3.1 The block catalog and the menus

One catalog, `components/editor/blocks/catalog.ts`, replaces `EditorBlockRegistry`'s flat
list. An entry has: `type`, `name`, `group` (`text`, `media`, `layout`, `embeds`,
`advanced`), `keywords`, `markdown` (the shortcut shown on the right), `icon`, `roles`
(Custom HTML: admins only), `insert(editor, range)`, optional `turnInto`. Every consumer
reads it:

- **Slash menu** ("Inserting blocks"): `/` on an empty line, five groups in the design's
  order, filtering by name and keywords with the matched part bold, "No blocks match
  “map”" with Esc keeping the text, ↑↓ across groups, a footer with the keys; no 10-item
  cap (the list scrolls). Inside a container's slot it offers only what the slot
  accepts (the nesting table); inside a caption or summary nothing (as the image caption
  does today).
- **+ in the margin** ("Inserting blocks", "+ in the margin, opened from the keyboard"):
  the gutter button next to the drag handle, opening the same list with its own search
  field; Esc returns focus to +.
- **Turn into** (`turnInto.ts`) and, later, the block menu (#356) read the same entries.
- Theme blocks (`installedThemeBlockEditors`) register into the catalog under their own
  group as now; only the active theme's blocks are offered.

The role gate in the menu is a convenience; enforcement for Custom HTML is server-side
(section 5).

### 3.2 Markdown shortcuts

TipTap input rules, gated by the existing "Markdown shortcuts" setting
(`lib/editorSettings.ts`): `#` to `######`, `-`, `1.`, `>`, ```` ``` ````, `---`,
plus `[]` for the to-do list (#352's comment). StarterKit provides most; the catalog shows
them, and a test asserts each one the catalog lists exists as an input rule (and is off
when the setting is off).

### 3.3 Inline marks

Highlight, superscript, subscript ("Editor · text blocks", "Paragraph"; "Keyboard",
"Formatting text": ⌘⇧H, ⌘., ⌘,):

- TipTap's Highlight (single colour: `multicolor: false`, so no `color` attr; text and
  background colours are #356), Superscript, Subscript, pinned at 3.4.2. Superscript and
  subscript exclude each other.
- The bubble menu gets the three buttons (not in captions, which keep bold/italic/link).
- Go: the sanitizer gets an **allowlist of mark types** (today any mark type passes
  through `sanitizeMarks` with only `on*` stripped), and drops `highlight`'s `color`.
- Renderer: `<mark>`, `<sup>`, `<sub>` in `contentRenderer`.
- Paste: `mark`, `sup`, `sub` allowed.
- Every mark is a rule 10 hazard (an unknown mark costs the text run, not just the mark),
  so marks ship after, or with, the schema guard (2.7).

### 3.3b Inline nodes (#320)

As built: `mention`, `contentLink` and `dateChip` are inline atoms (TipTap nodes in the
`inline` group), not marks, so they ride inside any text block's `pm` with no block type or
version change. Through the chain: Block Spec rules and normalizers
(`blocks-spec/inlineNodes.ts`, `inlineNodeVectors.json` shared with Go), the schema
(`schemaExtensions`, so the collab server has them; each changes the #416 fingerprint), the
bridge (nothing: pm JSON round-trips; `leafText` feeds `text`), the paste sanitizer (typed
`<span>`s only, values checked), the Go sanitizer (an allowlist per node,
`sanitizeInlineNode`), the public API (`publicizeInlineNodes`: names and current URLs, no ids)
and the renderer (`renderInlineNode`). Like a mark, every inline node is a rule 10 hazard, so it
shipped after the fingerprint guard. y-tiptap keeps marks on text only, so marks on these
nodes don't reach the shared doc.

### 3.4 The media picker

`MediaSelector` / `FeaturedImageSelector` become one `MediaPicker`: a `kind` filter
(`image`, `video`, `audio`, `document`, from `lib/mediaLibrary.ts`'s kinds), single or
multi-select (gallery), Upload in place (the library's `upload`), the "No alt text"
badge (#325), and **Replace** for an existing block. Every media block uses it: image
(today), gallery, video, audio, file, cover, media & text.

Shared media block behaviour, written once:

- **Alt text** (#325): optional alt plus "Decorative image"; a missing alt is flagged on
  the block, in its toolbar and in the panel ("Errors & empty states", "An image without
  alt text"), and published as `alt=""`. Gallery images are checked one by one.
- **Missing media** ("A media file that's missing"): "The file is missing" with Replace
  in the editor; left out of the published page with its caption (2.10).
- **Focal point** (cover, media & text): the media's own `focal_point` (#255) by default,
  overridable on the block, with the keyboard behaviour on "Keyboard", "Inside blocks".

### 3.5 Editing nested blocks

What the canvas asks for once there are containers ("Keyboard", "Moving between blocks";
"Editor · columns, group, buttons, spacer", "Others in nested layouts"):

- Esc selects the block around the caret; Esc again selects its container, up to the top;
  ↵ on a selected container steps into its first block; ↑↓ move between sibling blocks.
- The gutter (+ and drag handle) follows the hovered block at any depth; drag and drop
  works between slots (into another column), limited by the nesting table. Two people
  moving the same block at once get two copies, not a loss (2.12, "Moves are by id").
- Remote carets, selections and name labels stay readable inside nested blocks: no
  `overflow: hidden` that clips a label at a column edge; a label that would overflow
  flips side.
- The settings panel's Block tab shows the selected block, nested or not.

As built (#417): `components/editor/utils/blockTree.ts` (blocks at any depth, the table at a
drop, moves and deletes), `utils/gutterPlugin.ts` (the gutter and the drag, replacing
TipTap's top-level-only handle), `extensions/BlockNavigation.ts` (the keys),
`ui/BlockSettingsPanel.tsx` (the Block tab) and `utils/cursorAwareness.ts` (labels). Two
findings changed the plan: y-tiptap rewrites reordered siblings in place, which loses text
when two people move the same block, so a move reaches Yjs as a delete then an insert in one
Yjs transaction (`utils/blockMoveSync.ts`); and y-tiptap's restore of a selected block that
was just deleted throws, which `extensions/NodeSelectionGuard.ts` prevents. Rules:
`web/gl-admin/lib/collaboration/CLAUDE.md` ("Nested blocks in the editor").

### 3.6 Guard against stale editor tabs

The schema fingerprint check from 2.7. It belongs to the foundation because every later
step adds node or mark types.

---

## 4. Per block, in brief

What each sub-issue starts from. "Flow"/"container" refer to 2.2. Every block also gets
the full chain from #352: Block Spec entry and version, Zod validation, editor node
(toolbar, settings panel), Go sanitizer allowlist, renderer, default theme styles, and
tests at each step including the collab round trip.

| Block | Kind | Block Spec attrs (beyond `pm`/`text`) | Notes |
|---|---|---|---|
| Highlight, superscript, subscript | marks | — | 3.3 |
| Callout | flow | `tone` (`info`/`success`/`warning`/`danger`) | Icon plus a visually hidden label ("Info: "), `role="note"`. Content: paragraphs. Built in #419. |
| Pull quote | flow | `cite` (as quote's, capped) | Rendered as `figure.pullquote` with `figcaption`. Built in #419 (a textblock, like a heading). |
| To-do list | flow | — | TipTap TaskList/TaskItem; items are blocks with `checked`, like list items (the id predicate's list rule covers `taskItem`). Published read-only checkboxes. Built in #419: a third list type (`LIST_ITEMS`), `todo_item` children; the published look follows the default theme's tokens until the canvas has a board. |
| Table | flow | `caption` (runs), `headerRow` | TipTap table, cells restricted to `paragraph+` (no blocks in cells); the table is one block with its rows in `pm`. Published in a scrolling, focusable region. Built in #420: the block node is a `tableBlock` (grid + caption), outside the `block` group so it can't land in a quote or list item; `headerRow` is canonical (stored cells are all `tableCell`) and in the editor an attr of the grid, never a cell type, so toggling it can't drop a collaborator's typing. |
| Details | container | `summary` (runs), `open` | 2.4 (summary part, slot if TipTap's extension is used). |
| Footnotes | container + inline node | `footnoteRef`: inline atom with `footnoteId`; `footnotes` holds `footnote` blocks (id = footnoteId) | Numbered by order of references. The `footnotes` block is created by the insert command, never by an appendTransaction (rule 7). |
| Video, audio | flow | `mediaId`, `caption` | Native players. |
| File | flow | `mediaId`, `label` | A download link with type and size. |
| Gallery | container of `image` | `columns` (2–4), `caption` | Each image is an image block (alt, caption, reorder with ⌘⇧←/→). |
| Embed | flow | `provider`, `ref`, `title`, `caption` | Section 5. |
| Columns / column | container | 2.2 | Stack in order on phones. |
| Group | container | `style`, `align` | |
| Buttons | flow | `align` (`left`/`center`); buttons as child nodes (`button`: `href`, `variant`, label text) | Not a container in Block Spec: the buttons are parts, kept in `pm`. Their `href` is a node attr, which `sanitizePMNode` doesn't check today (it checks link marks only), so the Go side adds an `isSafeURL(href, safeHrefSchemes)` check on `button` nodes. |
| Spacer | flow | `size` (a theme spacing step, not px) | |
| Cover | container | 2.2 | Overlay 0–80 in steps of 5. |
| Media & text | container | 2.2 | Media above text on phones. |
| Custom HTML | flow | `snippetId` | Section 5. |

---

## 5. Recommendations for the open decisions

Each is confirmed (or changed) as the first acceptance item of its sub-issue.

**Embeds load nothing until the reader clicks** ("Editor · embeds, custom HTML",
"Published · media & embeds"):

- The editor posts the pasted URL to a new API route, `POST /embeds/resolve`, which
  matches it against the allowed providers (the stored `editor_allowed_embeds` setting,
  #330; its Settings field is unhidden in the same issue) with a per-provider URL pattern,
  and fetches the title from that provider's **fixed** oEmbed endpoint: HTTPS only, 3s
  timeout, 64 KB cap, no redirects to another host, nothing but the title read from the
  answer. A URL that matches no allowed provider is refused ("An embed link that isn't
  allowed").
- The block stores `provider`, `ref` (the provider's id, checked against that provider's
  pattern by the Go sanitizer) and `title` (plain text, capped). Never HTML from the
  provider.
- The renderer outputs a placeholder (title, "Load video", "Loading connects to
  youtube.com") with no third-party request, not even a thumbnail. A small script builds
  the iframe on click, from a URL template per provider, with `referrerpolicy`,
  `sandbox` where the provider allows it, and `loading`; X is a card that loads the
  provider's widget on click.
- **The public site has no CSP today** (`src/middleware/csp.ts` covers the admin and
  account pages only). #425 adds one for public pages with a single directive,
  `frame-src` limited to the allowed providers' embed hosts, so iframes can only come
  from them. No other directive, so themes' scripts, styles and fonts are unaffected.
  X's widget script can't be limited without a `script-src` that would constrain themes;
  that stays out of scope, and the script is only ever requested after a click.

**Custom HTML is admin-only, enforced by the server**:

- Recommended: **the HTML isn't in the Yjs doc.** The block holds a `snippetId`; the
  markup lives in a `post_html_snippets` row (post id, snippet id, html) written only
  through admin-only API routes. Any editor can move or delete the block (the canvas: "can
  still move it"), but no Yjs update can create or change markup, because there is none in
  the doc to change. A `snippetId` that doesn't belong to the post renders nothing.
  Publishing copies the sanitized markup into the published `block_doc` (`attrs.html`), so
  versions and the public page don't depend on the working table.
- The alternative, inspecting every Yjs update from a non-admin connection on the collab
  server and dropping any that touches an `html` element, needs decoding updates against
  the live doc and has no precedent in the server; it is the fallback if the snippet
  table is rejected.
- Public output: the API sanitizes the markup on write and on publish with an allowlist
  (no `script`, no `on*`, no `javascript:` URLs, no `iframe`/`object`/`embed`, `style`
  attributes allowed). The renderer emits only that sanitized string. Rendering scripts in
  a sandboxed frame is not offered in this issue.

---

## 6. Build order

The sub-issues of #352, in build order. "→" lists hard dependencies.

1. **#414 Nesting foundation** (P1): sections 2.2–2.11, proven end to end with the
   **Group** block (the simplest container; it ships). Depends on nothing; reads #315's
   state first.
2. **#415 Block menus** (P1): 3.1, 3.2. Independent of #414; can run alongside it.
   Slot-aware filtering is wired by whichever of the two merges second.
3. **#416 Schema fingerprint guard** (P1): 2.7 / 3.6. Independent. Should reach
   production before (or with) the first PR that adds a node or mark type, which is
   #414's Group; any such PR that ships before it says "reload open admin tabs after
   deploying".
4. **#417 Nested editing** (P1): 3.5. → #414.
5. **#418 Inline marks** (P2): 3.3. → #416.
6. **#419 Callout, pull quote, to-do list** (P2). → #415.
7. **#420 Table** (P2). → #415.
8. **#421 Details** (P2). → #414, #417.
9. **#422 Footnotes** (P2). → #414, #415.
10. **#423 Video, audio, file, and the media picker** (P2): 3.4, missing media. → #415.
11. **#424 Gallery** (P2). → #414, #417, #423.
12. **#425 Embeds** (P2): section 5. → #415.
13. **#426 Columns, buttons, spacer** (P2). → #414, #417.
14. **#427 Cover, media & text** (P2). → #414, #417, #423.
15. **#428 Custom HTML** (P2): section 5. → #415; last, once enforcement is agreed.

This keeps #352's order (marks and menus, text, media, embeds, layout, custom HTML) with
the foundation in front. #418–#420, #423 and #425 don't need nesting and can start once
the menus exist; everything that holds blocks waits for #414 and #417.

---

## 7. Open questions

- Should a group be allowed inside a column (cards in columns)? The table forbids it to
  stay acyclic (2.2). Decide before Columns (13) if the default theme needs it.
- Should lists nested in a list item be flattened into child blocks too (2.1)? Not needed
  for #352; it would let a nested item carry a comment (#192).
- Footnote text editing: inline in the Footnotes list only (the canvas), or also from
  the reference? The canvas shows the list; the issue starts there.
- Theme containers (2.11): out of scope here.
