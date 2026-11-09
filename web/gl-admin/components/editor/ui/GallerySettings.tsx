import { useEffect, useLayoutEffect, useRef, type ChangeEvent } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import { isRasterImage } from "@gl-admin/lib/mediaLibrary"
import { GALLERY_COLUMNS, normalizeGalleryColumns } from "@gl-admin/lib/blocks-spec"
import type { MediaLookup } from "@gl-admin/lib/mediaLookup"
import { chooseMediaFor } from "../blocks/mediaPicking"
import { galleryImages } from "../extensions/GalleryBlock"
import { refOfBlock, resolveEditorBlock, type BlockRef } from "../utils/blockTree"
import {
  onGalleryAltFocus,
  selectGalleryImage,
  setGalleryImageAlt,
  setGalleryImageCaption,
  takeGalleryAltFocus,
} from "../utils/galleryActions"
import { useMediaLookup } from "./MediaBlockSettings"

// The settings panel's Block tab for a gallery (#424, the canvas's "Editor · image,
// gallery…" and "Errors & empty states"): Columns, and the images one by one, each flagged
// "No alt text" on its own. The selected image's row opens its alt text and caption. A row
// finds its image by id when something is typed, and every change is one transaction (rule 7).

/**
 * Whether this gallery image is flagged "No alt text" (#325, per image): its own alt text is
 * blank and its media isn't marked decorative. A deleted file says so instead.
 */
export function galleryImageMissingAlt(alt: unknown, lookup: MediaLookup | { status: "loading" } | null): boolean {
  if (lookup?.status === "missing") return false
  if (typeof alt === "string" && alt.trim() !== "") return false
  return !(lookup?.status === "found" && lookup.media.decorative === true)
}

/**
 * A text field that always shows the document's value, so what's typed is compared with
 * what the post says now: a collaborator's change arrives while this user types, and the
 * caret stays where it was.
 */
function SyncedField({
  id,
  value,
  placeholder,
  inputRef,
  onType,
}: {
  id: string
  value: string
  placeholder?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  onType: (text: string) => void
}) {
  const own = useRef<HTMLInputElement>(null)
  const field = inputRef ?? own
  useLayoutEffect(() => {
    const input = field.current
    if (!input || input.value === value) return
    const before = input.value
    const { selectionStart, selectionEnd } = input
    input.value = value
    if (input.ownerDocument.activeElement !== input || selectionStart === null || selectionEnd === null) return
    // Keep the caret against the same text: what changed before it shifts it.
    const atEnd = before.length - selectionEnd
    let prefix = 0
    while (prefix < selectionStart && prefix < value.length && before[prefix] === value[prefix]) prefix++
    const caret = prefix === selectionStart ? selectionStart : Math.max(0, value.length - atEnd)
    input.setSelectionRange(caret, caret)
  }, [value, field])
  return (
    <input
      ref={field}
      id={id}
      type="text"
      className="gl-input block-settings__input"
      defaultValue={value}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onType(event.target.value)}
    />
  )
}

function ImageRow({
  editor,
  image,
  expanded,
  altRef,
}: {
  editor: TiptapEditor
  image: { node: PMNode; pos: number }
  expanded: boolean
  altRef: React.RefObject<HTMLInputElement | null>
}) {
  const ref: BlockRef = refOfBlock(image)
  const lookup = useMediaLookup(image.node.attrs.mediaId)
  const media = lookup?.status === "found" ? lookup.media : null
  const missing = lookup?.status === "missing"
  const name = media?.original_filename || media?.name || (image.node.attrs.title as string) || "Image"
  const thumb = media && isRasterImage(media) ? getMediaVariantPreviewURL(media, "thumb") : (image.node.attrs.src as string | null) || ""
  const noAlt = galleryImageMissingAlt(image.node.attrs.alt, lookup)
  const key = ref.id ?? String(ref.pos)
  const caption = image.node.firstChild?.textContent ?? ""

  const replace = () => {
    const block = resolveEditorBlock(editor.state.doc, ref)
    if (block) chooseMediaFor(editor, block.pos)
  }

  return (
    <li className={`block-settings__gallery-row${expanded ? " is-selected" : ""}`}>
      <button type="button" className="block-settings__gallery-pick" aria-expanded={expanded} onClick={() => selectGalleryImage(editor, ref)}>
        {!missing && thumb ? <img src={thumb} alt="" className="block-settings__file-thumb" /> : <span className="block-settings__file-thumb" aria-hidden="true" />}
        <span className="block-settings__gallery-name">{missing ? "The image file is missing" : name}</span>
        {noAlt && <span className="block-settings__pill is-warning">No alt text</span>}
      </button>
      {expanded && (
        <div className="block-settings__gallery-fields">
          <label className="post-settings__label" htmlFor={`gallery-alt-${key}`}>
            Alt text
          </label>
          <SyncedField
            id={`gallery-alt-${key}`}
            inputRef={altRef}
            value={(image.node.attrs.alt as string | null) ?? ""}
            placeholder="Describe the image for people who can't see it"
            onType={(text) => setGalleryImageAlt(editor, ref, text)}
          />
          <label className="post-settings__label" htmlFor={`gallery-caption-${key}`}>
            Caption <span className="block-settings__optional">(optional)</span>
          </label>
          <SyncedField
            id={`gallery-caption-${key}`}
            value={caption}
            placeholder="Shown under this image"
            onType={(text) => setGalleryImageCaption(editor, ref, text)}
          />
          {editor.isEditable && (
            <button type="button" className="block-settings__file-replace" onClick={replace}>
              Replace
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export default function GallerySettings({
  editor,
  gallery,
  galleryPos,
  selectedId,
  onColumns,
}: {
  editor: TiptapEditor
  gallery: PMNode
  galleryPos: number
  /** The image the selection is on or in: its row is open. */
  selectedId: string | null
  onColumns: (columns: number) => void
}) {
  const images = galleryImages(galleryPos, gallery)
  const columns = normalizeGalleryColumns(gallery.attrs.columns)
  const altRef = useRef<HTMLInputElement>(null)

  // ↵ on the selected image in the post: focus lands in its alt text, now or once the panel is up.
  useEffect(() => {
    const focus = () => {
      if (selectedId && takeGalleryAltFocus(editor, selectedId)) altRef.current?.focus()
    }
    focus()
    return onGalleryAltFocus(editor, focus)
  }, [editor, selectedId])

  return (
    <fieldset className="post-settings__fieldset block-settings__gallery" disabled={!editor.isEditable}>
      <div className="post-settings__field">
        <span className="post-settings__label" id="block-settings-gallery-columns">
          Columns
        </span>
        <div className="block-settings__segment" role="radiogroup" aria-labelledby="block-settings-gallery-columns">
          {GALLERY_COLUMNS.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={option === columns} className="block-settings__option" onClick={() => onColumns(option)}>
              {option}
            </button>
          ))}
        </div>
        <p className="post-settings__hint">On phones the gallery drops to 2 columns.</p>
      </div>
      <div className="post-settings__field">
        <span className="post-settings__label">Images</span>
        {images.length === 0 ? (
          <p className="post-settings__hint">None yet. Images you add get their alt text from Media.</p>
        ) : (
          <ul className="block-settings__gallery-list">
            {images.map((image) => {
              const id = image.node.attrs["data-block-id"] as string | null
              return <ImageRow key={id ?? image.pos} editor={editor} image={image} expanded={id !== null && id === selectedId} altRef={altRef} />
            })}
          </ul>
        )}
      </div>
    </fieldset>
  )
}
