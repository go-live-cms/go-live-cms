import React, { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import { getMedia, getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { formatTag, isRasterImage, mediaKind, mediaMetaLine, missingAlt, TYPE_FILTERS } from "@gl-admin/lib/mediaLibrary"
import { uploadMediaFile } from "@gl-admin/lib/mediaLookup"
import { MEDIA_KIND_ACCEPT, mimeMatchesKind, type MediaPickerKind } from "@gl-admin/lib/blocks-spec"
import type { Media } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/components/media/media-picker.scss"

// The media picker (#423, design `docs/design/block-library.md` 3.4): the one dialog for
// choosing media library files, from the featured and social images and from every media
// block (image, video, audio, file; gallery's several at once later). A `kind` limits it
// to one of the library's kinds (the API's `type`); without one, the library's own kind
// filter shows. Upload adds files to the library from here, as the library's Upload does,
// and (choosing one) picks what was uploaded. Images without alt text say so (#325).
//
// Keyboard: every tile is a button (Tab reaches the grid, then the arrow keys, Home and
// End move between tiles; Enter or Space picks). Escape closes (Modal).

export const KIND_NOUNS: Record<MediaPickerKind, { one: string; many: string; a: string }> = {
  image: { one: "image", many: "images", a: "an image" },
  video: { one: "video", many: "videos", a: "a video" },
  audio: { one: "audio file", many: "audio files", a: "an audio file" },
  document: { one: "file", many: "files", a: "a file" },
}

const PAGE_SIZE = 20

export interface MediaPickerProps {
  isOpen: boolean
  onClose: () => void
  /** One choice: the media, or null for the remove button. The picker closes itself after. */
  onSelect: (media: Media | null) => void
  /** Only this kind of file. Absent: every file, with the kind filter. */
  kind?: MediaPickerKind
  /** Several files at once, confirmed with the dialog's button (`onSelectMany`). */
  multiple?: boolean
  onSelectMany?: (media: Media[]) => void
  /** The file now in use: marked in the grid, and the remove button shows. */
  current?: Media | null
  title?: string
  /** The remove button's label (with `current`); none without one. */
  removeLabel?: string
  /** The button that confirms a multiple choice ("Add 3 images"). */
  confirmLabel?: (count: number) => string
}

export default function MediaPicker({
  isOpen,
  onClose,
  onSelect,
  kind,
  multiple = false,
  onSelectMany,
  current = null,
  title,
  removeLabel,
  confirmLabel,
}: MediaPickerProps) {
  const [items, setItems] = useState<Media[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<string>(kind ?? "")
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<Media[]>([])
  const [uploading, setUploading] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const request = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const grid = useRef<HTMLUListElement>(null)
  const ids = useId()

  const activeKind = (kind ?? (filter || undefined)) as MediaPickerKind | undefined
  const noun = activeKind ? KIND_NOUNS[activeKind] : { one: "file", many: "files", a: "a file" }

  const load = useCallback(
    async (offset: number) => {
      const started = ++request.current
      setLoading(true)
      setError(null)
      try {
        const response = await getMedia({
          limit: PAGE_SIZE,
          offset,
          sort: "date_desc",
          ...(activeKind ? { type: activeKind } : {}),
          ...(search ? { search } : {}),
        })
        if (started !== request.current) return
        // The API filters by kind; this only guards against a row it lists by mistake.
        const rows = activeKind ? response.data.filter((m) => mimeMatchesKind(m.mime_type, activeKind)) : response.data
        setItems((prev) => (offset === 0 ? rows : [...prev, ...rows.filter((m) => !prev.some((p) => p.id === m.id))]))
        setHasMore(response.data.length === PAGE_SIZE)
      } catch (e) {
        if (started === request.current) setError(errorMessage(e, "Failed to load media"))
      } finally {
        if (started === request.current) setLoading(false)
      }
    },
    [activeKind, search]
  )

  // A fresh list on open and on every filter change; the search waits for typing to stop.
  useEffect(() => {
    if (!isOpen) return
    const timer = setTimeout(() => load(0), search ? 300 : 0)
    return () => clearTimeout(timer)
  }, [isOpen, load, search])

  useEffect(() => {
    if (isOpen) return
    // Closed: the next open starts over (another block may open it with another kind).
    request.current++
    setSelected([])
    setUploadError(null)
    setUploading(null)
    setSearch("")
    setFilter(kind ?? "")
  }, [isOpen, kind])

  const pick = (media: Media) => {
    if (multiple) {
      setSelected((prev) => (prev.some((m) => m.id === media.id) ? prev.filter((m) => m.id !== media.id) : [...prev, media]))
      return
    }
    onSelect(media)
    onClose()
  }

  const confirm = () => {
    if (selected.length === 0) return
    onSelectMany?.(selected)
    onClose()
  }

  const remove = () => {
    onSelect(null)
    onClose()
  }

  // Upload in place: into the library, then picked (or added to the choice).
  const upload = async (files: File[]) => {
    if (files.length === 0) return
    const wrong = activeKind ? files.find((file) => file.type && !mimeMatchesKind(file.type, activeKind)) : undefined
    if (wrong) {
      setUploadError(`${wrong.name} isn't ${noun.a}. Choose ${noun.a} to upload.`)
      return
    }
    setUploadError(null)
    const uploaded: Media[] = []
    try {
      for (const file of multiple ? files : files.slice(0, 1)) {
        setUploading(file.name)
        uploaded.push(await uploadMediaFile(file))
      }
    } catch (e) {
      setUploadError(`Upload failed: ${errorMessage(e, "the file couldn't be uploaded")}`)
    } finally {
      setUploading(null)
    }
    if (uploaded.length === 0) return
    setItems((prev) => [...uploaded, ...prev.filter((m) => !uploaded.some((u) => u.id === m.id))])
    if (multiple) setSelected((prev) => [...prev, ...uploaded.filter((u) => !prev.some((m) => m.id === u.id))])
    else pick(uploaded[0])
  }

  // Arrow keys, Home and End between tiles (each tile is a button, so Tab and Enter work too).
  const onGridKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-media-tile]") ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    const top = buttons[0].offsetTop
    const columns = Math.max(1, buttons.filter((b) => b.offsetTop === top).length)
    const next = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      ArrowDown: at + columns,
      ArrowUp: at - columns,
      Home: 0,
      End: buttons.length - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    buttons[Math.min(buttons.length - 1, Math.max(0, next))]?.focus()
  }

  const heading = title ?? (multiple ? `Choose ${noun.many}` : `Choose ${noun.a}`)
  const isSelected = (media: Media) => (multiple ? selected.some((m) => m.id === media.id) : current?.id === media.id)

  const footer = multiple ? (
    <div className="gl-media-picker__footer">
      <span className="gl-media-picker__count" aria-live="polite">
        {selected.length === 0 ? `No ${noun.many} chosen` : `${selected.length} chosen`}
      </span>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" onClick={confirm} disabled={selected.length === 0}>
        {confirmLabel?.(selected.length) ?? `Add ${selected.length || ""} ${selected.length === 1 ? noun.one : noun.many}`.replace(/\s+/g, " ")}
      </Button>
    </div>
  ) : undefined

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={heading} size="large" footer={footer}>
      <div className="gl-media-picker">
        <div className="gl-media-picker__controls">
          <div className="gl-media-picker__search">
            <label htmlFor={`${ids}-search`} className="gl-media-picker__sr">
              Search {noun.many}
            </label>
            <input
              id={`${ids}-search`}
              type="search"
              placeholder={`Search ${noun.many}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="gl-media-picker__search-input"
            />
          </div>
          <div className="gl-media-picker__actions">
            <Button variant="secondary" onClick={() => fileInput.current?.click()} loading={uploading !== null}>
              Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple={multiple}
              accept={activeKind ? MEDIA_KIND_ACCEPT[activeKind] : undefined}
              aria-label={`Upload ${multiple ? noun.many : noun.a}`}
              data-testid="media-picker-upload"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ""
                void upload(files)
              }}
            />
            {current && removeLabel && (
              <button type="button" onClick={remove} className="gl-media-picker__remove-btn">
                {removeLabel}
              </button>
            )}
          </div>
        </div>

        {!kind && (
          <div className="gl-media-picker__filters" role="radiogroup" aria-label="Kind of file">
            {TYPE_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={filter === option.id}
                className="gl-media-picker__filter"
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        <p className="gl-media-picker__status" role="status" aria-live="polite">
          {uploading ? `Uploading ${uploading}…` : ""}
        </p>
        {uploadError && (
          <div className="gl-media-picker__error" role="alert">
            <p>{uploadError}</p>
          </div>
        )}
        {error && (
          <div className="gl-media-picker__error">
            <p>Error: {error}</p>
          </div>
        )}

        {items.length > 0 && (
          <ul ref={grid} className="gl-media-picker__grid" aria-label={`${noun.many[0].toUpperCase()}${noun.many.slice(1)}`} onKeyDown={onGridKeyDown}>
            {items.map((media) => {
              const chosen = isSelected(media)
              const noAlt = missingAlt(media)
              return (
                <li key={media.id}>
                  <button
                    type="button"
                    data-media-tile=""
                    className={`gl-media-picker__item${chosen ? " gl-media-picker__item--selected" : ""}`}
                    aria-pressed={multiple ? chosen : undefined}
                    aria-current={!multiple && chosen ? "true" : undefined}
                    aria-label={`${media.name}${noAlt ? ", no alt text" : ""}`}
                    onClick={() => pick(media)}
                  >
                    <span className="gl-media-picker__thumbnail">
                      {isRasterImage(media) ? (
                        <img src={getMediaVariantPreviewURL(media, "thumb")} alt="" loading="lazy" />
                      ) : (
                        <span className={`gl-media-picker__kind gl-media-picker__kind--${mediaKind(media)}`} aria-hidden="true">
                          {formatTag(media)}
                        </span>
                      )}
                      {noAlt && (
                        <span className="gl-media-picker__alt" aria-hidden="true">
                          No alt text
                        </span>
                      )}
                      {chosen && (
                        <span className="gl-media-picker__selected-indicator" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </span>
                    <span className="gl-media-picker__info">
                      <span className="gl-media-picker__name" title={media.name}>
                        {media.name}
                      </span>
                      <span className="gl-media-picker__meta">{mediaMetaLine(media)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {loading && items.length === 0 && (
          <div className="gl-media-picker__loading" aria-busy="true">
            <div className="gl-media-picker__grid">
              {Array.from({ length: 12 }).map((_, index) => (
                <div key={index} className="gl-media-picker__item gl-media-picker__item--skeleton">
                  <div className="gl-media-picker__thumbnail skeleton"></div>
                  <div className="gl-media-picker__info">
                    <div className="gl-media-picker__name skeleton"></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasMore && !loading && items.length > 0 && (
          <div className="gl-media-picker__load-more">
            <button type="button" onClick={() => load(items.length)} className="gl-media-picker__load-more-btn">
              Load more {noun.many}
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="gl-media-picker__empty">
            {search ? (
              <>
                <p>
                  No {noun.many} found for "{search}"
                </p>
                <button type="button" onClick={() => setSearch("")} className="gl-media-picker__clear-search">
                  Clear search
                </button>
              </>
            ) : (
              <p>No {noun.many} yet. Upload one, or add some in Media.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
