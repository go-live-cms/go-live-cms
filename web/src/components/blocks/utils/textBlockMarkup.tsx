import React from "react"
import { CALLOUT_TONE_ICONS, CALLOUT_TONE_LABELS, normalizeCalloutTone, normalizeCite } from "@gl-admin/lib/blocks-spec"
import type { PMNode } from "../types"

// The public markup of the #419 blocks, shared by their components (a top-level block)
// and by `renderContent` (the same node inside a quote's or a list item's pm), so a
// callout, pull quote or to-do list renders the same wherever the editor let it go.
// Nothing here imports contentRenderer: inline content is rendered by the caller's
// `renderInline`.

type RenderInline = (content: PMNode[] | undefined) => React.ReactNode

/**
 * `div.callout.is-<tone>` with `role="note"`, the tone's icon (decorative) and one `<p>`
 * per paragraph, the first starting with the tone said in words (`.sr-only`), so the
 * meaning never rests on colour. A missing or unknown tone is info. Without paragraphs,
 * `text` (a block stored without its pm).
 */
export function calloutMarkup({
  tone: rawTone,
  content,
  text,
  renderInline,
  id,
  key,
}: {
  tone: unknown
  content: PMNode[] | undefined
  text?: unknown
  renderInline: RenderInline
  id?: string
  key?: React.Key
}): React.ReactElement {
  const tone = normalizeCalloutTone(rawTone)
  const label = <span className="sr-only">{`${CALLOUT_TONE_LABELS[tone]}: `}</span>
  const paragraphs = (content ?? []).filter((node) => node?.type === "paragraph")
  return (
    <div key={key} id={id} className={`callout is-${tone}`} role="note">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={CALLOUT_TONE_ICONS[tone]} />
      </svg>
      <div className="callout-body">
        {paragraphs.length > 0 ? (
          paragraphs.map((paragraph, index) => (
            <p key={index}>
              {index === 0 && label}
              {renderInline(paragraph.content)}
            </p>
          ))
        ) : (
          <p>
            {label}
            {typeof text === "string" ? text : null}
          </p>
        )}
      </div>
    </div>
  )
}

/** `figure.pullquote > blockquote > p`, the citation (plain text, the quote's rules) as `figcaption`. */
export function pullQuoteMarkup({
  content,
  cite: rawCite,
  id,
  key,
}: {
  content: React.ReactNode
  cite: unknown
  id?: string
  key?: React.Key
}): React.ReactElement {
  const cite = normalizeCite(rawCite)
  return (
    <figure key={key} id={id} className="pullquote">
      <blockquote>
        <p>{content}</p>
      </blockquote>
      {cite && <figcaption>{cite}</figcaption>}
    </figure>
  )
}

export interface TodoItemMarkup {
  key: React.Key
  checked: boolean
  content: React.ReactNode
  /** The id of the item's text element, for its checkbox's `aria-labelledby`; else `label`. */
  labelId?: string
  label: string
}

/**
 * `ul.todo-list`, one `li.todo-item` (`is-checked` when done) per item with a **read-only**
 * checkbox: `disabled`, so readers can't toggle it and it isn't a tab stop, and labelled by
 * the item's text.
 */
export function todoListMarkup({ items, id, key }: { items: TodoItemMarkup[]; id?: string; key?: React.Key }): React.ReactElement {
  return (
    <ul key={key} id={id} className="todo-list">
      {items.map((item) => (
        <li key={item.key} className={item.checked ? "todo-item is-checked" : "todo-item"}>
          <input
            type="checkbox"
            checked={item.checked}
            disabled
            readOnly
            {...(item.labelId ? { "aria-labelledby": item.labelId } : { "aria-label": item.label })}
          />
          <span className="todo-item__text" id={item.labelId}>
            {item.content}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The plain text of PM content (a to-do item's label when it has no safe id). */
export function plainText(content: PMNode[] | undefined): string {
  // Text runs join as they are (a mark can split a word); blocks are separated by a space.
  return (content ?? [])
    .map((node) => (node.type === "text" ? (node.text ?? "") : ` ${plainText(node.content)} `))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
}
