import React, { Fragment, memo } from "react"
import { normalizeCite, type Block, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { PostSettings } from "@gl-admin/lib/api/blockAPI"
import { blockRendererFor } from "@/components/BlockRenderer"
import { renderTextNode } from "@/components/blocks/utils/contentRenderer"
import {
  blockTypeLabel,
  isIdentical,
  type AttrChange,
  type BlockDiffEntry,
  type BlockDocDiff,
  type ItemDiff,
  type ListDiff,
} from "@gl-admin/lib/history/blockDiff"
import { diffText, hasChanges, type Segment } from "@gl-admin/lib/history/wordDiff"

// History · 1 with "Highlight changes" on (#355): the version shown read-only, compared
// with the working copy. Blocks only in the version or only in the working copy carry a
// label and an icon (never colour alone); changed blocks show inline insertions (<ins>,
// underlined) and deletions (<del>, struck through); unchanged blocks are dimmed with
// --text-secondary, which keeps AA contrast. Colours are the #337 tokens only.

export const VERSION_ONLY_LABEL = "Only in this version"
export const WORKING_ONLY_LABEL = "Only in working copy"
export const MOVED_LABEL = "Moved in the working copy"

const PlusIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.25"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const MinusIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.25"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M5 12h14" />
  </svg>
)
const MoveIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m8 7 4-4 4 4M8 17l4 4 4-4M12 3v18" />
  </svg>
)

// Class names joined with spaces (not in a template literal: the Tailwind Prettier plugin
// trims the leading space of a conditional part there, gluing two names together).
const classes = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ")

type LabelKind = "version" | "working" | "moved"

const LABEL_TEXT: Record<LabelKind, string> = {
  version: VERSION_ONLY_LABEL,
  working: WORKING_ONLY_LABEL,
  moved: MOVED_LABEL,
}
const LABEL_ICON: Record<LabelKind, () => React.ReactElement> = {
  version: PlusIcon,
  working: MinusIcon,
  moved: MoveIcon,
}

export function DiffLabel({ kind }: { kind: LabelKind }) {
  const Icon = LABEL_ICON[kind]
  return (
    <span className={`version-diff__label version-diff__label--${kind}`}>
      <Icon />
      {LABEL_TEXT[kind]}
    </span>
  )
}

/** Inline word-diff segments, with their marks. */
export function DiffText({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, i) => {
        // An inline node (a theme's) has no text: shown by its type, so a change to it shows.
        const inner =
          segment.kind === "node" ? (
            <span className="version-diff__node">[{segment.text}]</span>
          ) : segment.kind ? (
            <br />
          ) : (
            renderTextNode({ type: "text", text: segment.text, marks: segment.marks }, i)
          )
        if (segment.op === "version") {
          return (
            <ins key={i} className="version-diff__ins">
              {inner}
            </ins>
          )
        }
        if (segment.op === "working") {
          return (
            <del key={i} className="version-diff__del">
              {inner}
            </del>
          )
        }
        return <Fragment key={i}>{inner}</Fragment>
      })}
    </>
  )
}

function AttrNotes({ attrs }: { attrs: AttrChange[] }) {
  if (attrs.length === 0) return null
  return (
    <ul className="version-diff__attrs" aria-label="Attributes changed">
      {attrs.map((a) => (
        <li key={a.key}>
          <span className="version-diff__attr-name">{a.label}:</span>{" "}
          <ins className="version-diff__ins">{a.version ?? "none"}</ins> in this version,{" "}
          <del className="version-diff__del">{a.working ?? "none"}</del> in working copy
        </li>
      ))}
    </ul>
  )
}

const textAlignOf = (block: Block): React.CSSProperties => {
  const align = ((block.attrs as { pm?: { attrs?: { textAlign?: string } } })?.pm?.attrs?.textAlign ??
    undefined) as React.CSSProperties["textAlign"]
  return align ? { textAlign: align } : {}
}

function headingTag(block: Block): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  const level = Number((block.attrs as { level?: unknown }).level)
  return (Number.isInteger(level) && level >= 1 && level <= 6 ? `h${level}` : "h1") as "h1"
}

function ItemMarker({ status, moved }: { status: ItemDiff["status"]; moved: boolean }) {
  if (status === "version" || status === "working") {
    return (
      <span className={`version-diff__item-mark version-diff__item-mark--${status}`}>
        {status === "version" ? <PlusIcon /> : <MinusIcon />}
        <span className="version-diff__sr">{status === "version" ? VERSION_ONLY_LABEL : WORKING_ONLY_LABEL}: </span>
      </span>
    )
  }
  if (moved) {
    return (
      <span className="version-diff__item-mark version-diff__item-mark--moved">
        <MoveIcon />
        <span className="version-diff__sr">{MOVED_LABEL}: </span>
      </span>
    )
  }
  return null
}

function DiffList({ list }: { list: ListDiff }) {
  const Tag = list.ordered ? "ol" : "ul"
  return (
    <Tag className={`version-diff__list version-diff__list--${list.status}`}>
      {list.items.map((item, i) => {
        const body = (
          <>
            <ItemMarker status={item.status} moved={item.moved} />
            <DiffText segments={item.text} />
            {item.attrs && <AttrNotes attrs={item.attrs} />}
            {item.lists.map((nested, j) => (
              <DiffList key={j} list={nested} />
            ))}
          </>
        )
        return (
          <li
            key={item.id ?? `#${i}`}
            className={classes(
              "version-diff__item",
              `version-diff__item--${item.status}`,
              item.moved && "version-diff__item--moved"
            )}
          >
            {item.status === "version" ? (
              <ins className="version-diff__whole">{body}</ins>
            ) : item.status === "working" ? (
              <del className="version-diff__whole">{body}</del>
            ) : (
              body
            )}
          </li>
        )
      })}
    </Tag>
  )
}

/** A block nothing here renders (a removed theme's block): say so instead of showing nothing. */
function Unrenderable({ block }: { block: Block }) {
  return <p className="version-diff__unrenderable">A {blockTypeLabel(block.type)} block this editor can't show.</p>
}

function renderOne(doc: BlockDocV1, id: string): React.ReactNode {
  const block = doc.blocks[id]
  if (!block) return null
  return blockRendererFor(doc)(id) ?? <Unrenderable block={block} />
}

/** A changed block: its own markup with the diff inside, or the rendered block plus notes. */
function ChangedBlock({ entry, version, working }: { entry: BlockDiffEntry; version: BlockDocV1; working: BlockDocV1 }) {
  const block = version.blocks[entry.id]
  const typeChanged = entry.attrs.some((a) => a.key === "type")
  const text = entry.text

  if (entry.list && !typeChanged) return <DiffList list={entry.list} />

  // A container in both (#414): each child as its own diff block, at any depth.
  if (entry.children && !typeChanged) {
    return (
      <div className="version-diff__container" data-type={block.type}>
        {/* A details' summary (#421), as its own line above its blocks. */}
        {block.type === "details" && entry.caption && entry.caption.length > 0 && (
          <p className="version-diff__summary">
            <DiffText segments={entry.caption} />
          </p>
        )}
        {entry.children.map((child) => (
          <DiffBlock key={`${child.status}:${child.id}`} entry={child} version={version} working={working} />
        ))}
      </div>
    )
  }

  if (!typeChanged && text) {
    switch (block.type) {
      case "paragraph":
        return (
          <p style={textAlignOf(block)}>
            <DiffText segments={text} />
          </p>
        )
      case "heading": {
        const Tag = headingTag(block)
        return (
          <Tag style={textAlignOf(block)}>
            <DiffText segments={text} />
          </Tag>
        )
      }
      case "blockquote": {
        // As the site renders it (BlockquoteBlock).
        const cite = normalizeCite((block.attrs as { cite?: unknown }).cite)
        return (
          <blockquote>
            <DiffText segments={text} />
            {cite && <cite>{cite}</cite>}
          </blockquote>
        )
      }
      case "code_block":
        return (
          <pre>
            <code>
              <DiffText segments={text} />
            </code>
          </pre>
        )
    }
  }

  if (["image", "table", "video", "audio", "embed"].includes(block.type) && !typeChanged) {
    // The image (or table, #420, or video or audio, #423) as it renders, with its caption
    // replaced by the caption's diff; a table's changed cell text under it.
    const attrs = { ...(block.attrs as Record<string, unknown>) }
    delete attrs.caption
    const bare = { ...version, blocks: { ...version.blocks, [entry.id]: { ...block, attrs } as Block } }
    const hasCaption = !!entry.caption && entry.caption.length > 0
    return (
      <>
        {renderOne(bare, entry.id)}
        {hasCaption && (
          <p className="version-diff__caption">
            <DiffText segments={entry.caption!} />
          </p>
        )}
        {block.type === "table" && text && hasChanges(text) && (
          <p className="version-diff__text-changes">
            <span className="version-diff__attr-name">Cells:</span> <DiffText segments={text} />
          </p>
        )}
      </>
    )
  }

  // Theme blocks, dividers, a block turned into another type: the version's block as it
  // renders, and its text's diff under it.
  return (
    <>
      {renderOne(version, entry.id)}
      {text && hasChanges(text) && (
        <p className="version-diff__text-changes">
          <span className="version-diff__attr-name">Text:</span> <DiffText segments={text} />
        </p>
      )}
    </>
  )
}

function DiffBlock({ entry, version, working }: { entry: BlockDiffEntry; version: BlockDocV1; working: BlockDocV1 }) {
  const className = classes(
    "version-diff__block",
    `version-diff__block--${entry.status}`,
    entry.moved && "version-diff__block--moved"
  )
  if (entry.status === "version" || entry.status === "working") {
    const doc = entry.status === "version" ? version : working
    const Whole = entry.status === "version" ? "ins" : "del"
    return (
      <div className={className} data-block-id={entry.id}>
        <DiffLabel kind={entry.status} />
        <Whole className="version-diff__whole">{renderOne(doc, entry.id)}</Whole>
      </div>
    )
  }
  return (
    <div className={className} data-block-id={entry.id}>
      {entry.moved && <DiffLabel kind="moved" />}
      {entry.status === "changed" ? <ChangedBlock entry={entry} version={version} working={working} /> : renderOne(version, entry.id)}
      <AttrNotes attrs={entry.attrs} />
    </div>
  )
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "2 blocks changed · 1 only in this version · …", for the notice above the comparison. */
export function diffSummaryText(diff: BlockDocDiff): string {
  const { changed, versionOnly, workingOnly, moved } = diff.summary
  const parts: string[] = []
  if (changed) parts.push(`${plural(changed, "block", "blocks")} changed`)
  if (versionOnly) parts.push(`${versionOnly} only in this version`)
  if (workingOnly) parts.push(`${workingOnly} only in working copy`)
  if (moved) parts.push(`${moved} moved`)
  return parts.length > 0 ? parts.join(" · ") : "Same content as the working copy"
}

/**
 * The blocks of the version, compared with the working copy. Memoized: a long comparison
 * re-renders only when the diff or the docs change, not with every render of the page.
 */
export default memo(function VersionDiff({
  diff,
  version,
  working,
}: {
  diff: BlockDocDiff
  version: BlockDocV1
  working: BlockDocV1
}) {
  return (
    <div className={classes("version-diff", isIdentical(diff) && "version-diff--identical")} data-testid="version-diff">
      <div className="block-content">
        {diff.entries.map((entry) => (
          <DiffBlock key={`${entry.status}:${entry.id}`} entry={entry} version={version} working={working} />
        ))}
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------------------
// Settings (#358): what the version would put back besides its blocks.

interface SettingRow {
  label: string
  segments?: Segment[]
  version?: string
  working?: string
}

const yesNo = (v: boolean | undefined) => (v ? "Hidden from search" : "Shown in search")

function textRow(label: string, version: string | undefined, working: string | undefined): SettingRow | null {
  const v = version ?? ""
  const w = working ?? ""
  if (v === w) return null
  return { label, segments: diffText(w, v) }
}

function valueRow(label: string, version: string, working: string): SettingRow | null {
  return version === working ? null : { label, version, working }
}

/** The settings that differ, in the order of the post's settings panel. Title is shown as the heading. */
export function settingsRows(version: PostSettings, working: PostSettings): SettingRow[] {
  const image = (s: PostSettings) =>
    s.featured_image?.id ? `Image #${s.featured_image.id}` : s.featured_image?.url ? "An image" : "None"
  const terms = (s: PostSettings) => [...(s.term_ids ?? [])].sort((a, b) => a - b).join(",")
  const termsText = (s: PostSettings) => plural((s.term_ids ?? []).length, "term", "terms")
  const rows = [
    textRow("Excerpt", version.description, working.description),
    valueRow("Featured image", image(version), image(working)),
    terms(version) === terms(working)
      ? null
      : { label: "Categories and tags", version: termsText(version), working: termsText(working) },
    textRow("SEO title", version.seo_title, working.seo_title),
    textRow("Meta description", version.seo_description, working.seo_description),
    valueRow(
      "Social image",
      version.social_image_id ? `Image #${version.social_image_id}` : "None",
      working.social_image_id ? `Image #${working.social_image_id}` : "None"
    ),
    valueRow("Search engines", yesNo(version.noindex), yesNo(working.noindex)),
    textRow("Canonical URL", version.canonical_url, working.canonical_url),
  ]
  return rows.filter((r): r is SettingRow => r !== null)
}

export function SettingsDiff({ version, working }: { version: PostSettings; working: PostSettings }) {
  const rows = settingsRows(version, working)
  return (
    <section className="version-diff__settings" aria-label="Settings in this version">
      <h2 className="version-diff__settings-title">Settings in this version</h2>
      {rows.length === 0 ? (
        <p className="version-diff__settings-same">Same as the working copy</p>
      ) : (
        <dl className="version-diff__settings-grid">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                {row.segments ? (
                  <DiffText segments={row.segments} />
                ) : (
                  <>
                    <ins className="version-diff__ins">{row.version}</ins> in this version,{" "}
                    <del className="version-diff__del">{row.working}</del> in working copy
                  </>
                )}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  )
}

/** The version's title, with the word diff against the working copy's when highlighting. */
export function TitleDiff({ version, working }: { version: string; working: string | null }) {
  return (
    <h1 className="revisions-preview__title">
      {working === null || working === version ? version : <DiffText segments={diffText(working, version)} />}
    </h1>
  )
}
