import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import type { Media } from "@gl-admin/lib/api/types"
import {
  capMediaAlt,
  COVER_ALIGNS,
  COVER_OVERLAY_MAX,
  COVER_OVERLAY_MIN,
  COVER_OVERLAY_STEP,
  focalFromMedia,
  focalOfNodeAttrs,
  focalPosition,
  isBlockDecorative,
  isCoverAlign,
  isMediaTextPosition,
  MEDIA_TEXT_POSITIONS,
  moveFocal,
  needsAltText,
  normalizeCoverOverlay,
  normalizeFocalAxis,
  type CoverAlign,
  type FocalPercent,
  type MediaTextPosition,
} from "@gl-admin/lib/blocks-spec"
import { focalPointFromClick } from "@gl-admin/components/media/FocalPointPicker"
import { keepBlockSelected, refOfBlock, resolveEditorBlock, type BlockRef, type EditorBlock } from "../utils/blockTree"
import { onGalleryAltFocus, takeGalleryAltFocus } from "../utils/galleryActions"
import Segment from "./BlockSettingsSegment"
import { SyncedField } from "./GallerySettings"
import { MediaFileRow, useMediaLookup } from "./MediaBlockSettings"

// The settings panel's Block tab for cover and media & text (#427, the canvas's "Editor ·
// cover, media & text"). Each control is one transaction this user makes, the block found by
// id when it runs (a collaborator's edit moves positions, never ids); none is an
// appendTransaction (rule 7).

export const NO_ALT_HELP = "This image has no alt text. Describe it, or mark it decorative if it adds nothing to the post."
export const COVER_ALT_HELP = "The text on a cover usually carries the meaning. Untick to describe the image as well."
export const OVERLAY_HELP = "Darkens the image so the text on it stays readable."
export const MEDIA_POSITION_HELP = "On phones the media always sits above the text."

const WIDTH_LABELS: Record<CoverAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const POSITION_LABELS: Record<MediaTextPosition, string> = { left: "Left", right: "Right" }

function setAttrs(editor: TiptapEditor, ref: BlockRef, attrs: Record<string, unknown>) {
  if (!editor.isEditable) return
  const block = resolveEditorBlock(editor.state.doc, ref)
  if (!block || Object.entries(attrs).every(([name, value]) => block.node.attrs[name] === value)) return
  const { state } = editor
  editor.view.dispatch(keepBlockSelected(state, block.pos, state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, ...attrs })))
}

/** One axis of the focal point: the X and Y fields "take exact values" ("Keyboard"). */
function AxisField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const id = useId()
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <div className="block-settings__unit">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = /^\d{1,3}$/.test(event.target.value) ? normalizeFocalAxis(Number(event.target.value)) : null
          if (parsed !== null) onCommit(parsed)
        }}
        onBlur={() => setText(String(value))}
      />
      <span aria-hidden="true">%</span>
    </div>
  )
}

/**
 * The focal point: the image with its dot, and exact X and Y. Arrow keys on the dot move it
 * 1%, with Shift 10% ("Keyboard" › "Inside blocks"); a click on the image puts it there.
 * Until someone moves it, the block follows the media's own focal point.
 */
export function FocalPointField({ editor, block, media }: { editor: TiptapEditor; block: EditorBlock; media: Media }) {
  const labelId = useId()
  const ref = refOfBlock(block)
  const focal = focalOfNodeAttrs(block.node.attrs) ?? focalFromMedia(media.focal_point)
  const place = (next: FocalPercent) => setAttrs(editor, ref, { focalX: next.x, focalY: next.y })

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!editor.isEditable) return
    place(focalFromMedia(focalPointFromClick(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = moveFocal(focal, event.key, event.shiftKey)
    if (!next) return
    event.preventDefault()
    place(next)
  }

  return (
    <div className="post-settings__field">
      <span className="post-settings__label" id={labelId}>
        Focal point
      </span>
      <div className="block-settings__focal" onClick={onClick}>
        <img src={getMediaVariantPreviewURL(media, "medium")} alt="" draggable={false} style={{ objectPosition: focalPosition(focal) }} />
        <button
          type="button"
          className="block-settings__focal-dot"
          aria-labelledby={labelId}
          aria-description={`${focal.x}% from the left, ${focal.y}% from the top. Arrow keys move it 1%, with Shift 10%.`}
          style={{ left: `${focal.x}%`, top: `${focal.y}%` }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="block-settings__focal-xy">
        <AxisField label="X" value={focal.x} onCommit={(x) => place({ ...focal, x })} />
        <AxisField label="Y" value={focal.y} onCommit={(y) => place({ ...focal, y })} />
      </div>
    </div>
  )
}

/** Alt text and "Decorative image" (#325), each block's as drawn: a cover's switch comes first. */
function AltField({ editor, block, media, type }: { editor: TiptapEditor; block: EditorBlock; media: Media | null; type: "cover" | "media_text" }) {
  const fieldId = useId()
  const helpId = useId()
  const altRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const ref = refOfBlock(block)
  const id = ref.id
  const decorative = isBlockDecorative(type, block.node.attrs.decorative)
  const flagged = media !== null && needsAltText(block.node.attrs.alt, decorative, media.decorative === true)

  // The block's "No alt text" flag and toolbar button: focus lands here, now or once the panel is up.
  useEffect(() => {
    const focus = () => {
      if (id && takeGalleryAltFocus(editor, id)) altRef.current?.focus()
    }
    focus()
    return onGalleryAltFocus(editor, focus)
  }, [editor, id])

  const check = (
    <label className="block-settings__check">
      <input type="checkbox" checked={decorative} onChange={(event) => setAttrs(editor, ref, { decorative: event.target.checked })} />
      Decorative image, no alt text
    </label>
  )
  return (
    <div className="post-settings__field">
      <label className="post-settings__label" htmlFor={fieldId}>
        Alt text
      </label>
      {type === "cover" && check}
      <SyncedField
        id={fieldId}
        rows={2}
        inputRef={altRef}
        value={(block.node.attrs.alt as string | null) ?? ""}
        placeholder="Describe the image for people who can't see it"
        disabled={decorative}
        invalid={flagged}
        describedBy={flagged ? helpId : undefined}
        onType={(text) => setAttrs(editor, ref, { alt: capMediaAlt(text) || null })}
      />
      {type === "media_text" && check}
      {flagged && (
        <p id={helpId} className="post-settings__hint block-settings__warning">
          {NO_ALT_HELP}
        </p>
      )}
      {type === "cover" && <p className="post-settings__hint">{COVER_ALT_HELP}</p>}
    </div>
  )
}

export function CoverSettings({ editor, block }: { editor: TiptapEditor; block: EditorBlock }) {
  const ref = refOfBlock(block)
  const lookup = useMediaLookup(block.node.attrs.mediaId)
  const media = lookup?.status === "found" ? lookup.media : null
  const overlay = normalizeCoverOverlay(block.node.attrs.overlay)
  const overlayId = useId()
  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      <div className="block-settings__media">
        <MediaFileRow editor={editor} node={block.node} blockRef={ref} kind="image" />
      </div>
      <AltField editor={editor} block={block} media={media} type="cover" />
      {media && <FocalPointField editor={editor} block={block} media={media} />}
      <div className="post-settings__field">
        <div className="block-settings__row">
          <label className="post-settings__label" htmlFor={overlayId}>
            Overlay
          </label>
          <span className="block-settings__value">{overlay}%</span>
        </div>
        <input
          id={overlayId}
          className="block-settings__range"
          type="range"
          min={COVER_OVERLAY_MIN}
          max={COVER_OVERLAY_MAX}
          step={COVER_OVERLAY_STEP}
          value={overlay}
          onChange={(event) => setAttrs(editor, ref, { overlay: normalizeCoverOverlay(Number(event.target.value)) })}
        />
        <p className="post-settings__hint">{OVERLAY_HELP}</p>
      </div>
      <Segment
        label="Width"
        values={COVER_ALIGNS}
        labels={WIDTH_LABELS}
        value={isCoverAlign(block.node.attrs.align) ? block.node.attrs.align : "content"}
        onPick={(value) => setAttrs(editor, ref, { align: value })}
      />
    </fieldset>
  )
}

export function MediaTextSettings({ editor, block }: { editor: TiptapEditor; block: EditorBlock }) {
  const ref = refOfBlock(block)
  const lookup = useMediaLookup(block.node.attrs.mediaId)
  const media = lookup?.status === "found" ? lookup.media : null
  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      <Segment
        label="Media position"
        values={MEDIA_TEXT_POSITIONS}
        labels={POSITION_LABELS}
        value={isMediaTextPosition(block.node.attrs.position) ? block.node.attrs.position : "left"}
        onPick={(value) => setAttrs(editor, ref, { position: value })}
      />
      <p className="post-settings__hint">{MEDIA_POSITION_HELP}</p>
      <AltField editor={editor} block={block} media={media} type="media_text" />
      {media && <FocalPointField editor={editor} block={block} media={media} />}
    </fieldset>
  )
}
