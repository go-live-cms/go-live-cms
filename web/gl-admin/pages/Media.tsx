import { useEffect, useRef, useState, type DragEvent } from "react"
import { useSearchParams } from "react-router-dom"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import MediaGrid, { type UploadingFile } from "@gl-admin/components/media/MediaGrid"
import MediaPanel from "@gl-admin/components/media/MediaPanel"
import { DeleteMediaDialog } from "@gl-admin/components/media/mediaActions"
import Button from "@gl-admin/components/ui/Button"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import FilterSelect from "@gl-admin/components/ui/FilterSelect"
import { SearchIcon, UploadIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { getMedia, createMedia } from "@gl-admin/lib/api/media"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { MEDIA_SORTS, TYPE_FILTERS, countLine, findMediaSort } from "@gl-admin/lib/mediaLibrary"
import { canCreateContent, canWriteMedia } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { useListParams } from "@gl-admin/lib/hooks/useListParams"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import type { Media as MediaItem } from "@gl-admin/lib/types"
import "@gl-admin/assets/styles/pages/content-list.scss"
import "@gl-admin/assets/styles/pages/media.scss"

// The media library (#342): the grid with variant previews, search, the type filter and
// sort (all in the URL), bulk select and delete, uploads by button or drop, and a side
// panel for the open file (?file=id) with "Edit details" for the detail page.
//
// Hidden until #325 lands: the "Missing alt text" filter and the tiles' "No alt text"
// tag. The board's "1.2 GB" total has no API (the count line shows files only).

const PAGE_SIZE = 24
const ACCEPT = "image/*,video/*,audio/*,.pdf,.doc,.docx,.txt"

export default function Media() {
  const { baseTitle } = useGoLive()
  const user = useAuthUser()
  // Every content role may upload (requireContentAuthor in the API, #135); editing or
  // deleting someone else's media is still moderators only (canWriteMedia).
  const canUpload = canCreateContent(user?.role)
  const asDrawer = useMediaQuery(MOBILE_QUERY)
  const [params, setParam] = useListParams()
  const [, setSearchParams] = useSearchParams()
  const type = TYPE_FILTERS.some((t) => t.id === params.get("type")) ? params.get("type")! : ""
  const sort = findMediaSort(params.get("sort"))
  const search = params.get("q") ?? ""
  const openId = Number(params.get("file")) || null

  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [uploads, setUploads] = useState<UploadingFile[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<MediaItem[]>([])
  const [toDelete, setToDelete] = useState<MediaItem[]>([])
  // The search box's text; the URL (and the request) follow it after a pause.
  const [searchText, setSearchText] = useState(search)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `${baseTitle} Media`
  }, [baseTitle])

  useEffect(() => {
    if (searchText.trim() === search) return
    const id = setTimeout(() => setParam("q", searchText.trim(), ""), 400)
    return () => clearTimeout(id)
  }, [searchText])

  const query = { search: search || undefined, type: type || undefined, sort }

  useEffect(() => {
    let live = true
    setLoading(true)
    getMedia({ limit: PAGE_SIZE, offset: 0, with_counts: true, ...query })
      .then((response) => {
        if (!live) return
        setItems(response.data)
        setTotal(response.meta?.total ?? response.data.length)
        setError(null)
      })
      .catch((e) => live && setError(errorMessage(e, "Failed to fetch media")))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [search, type, sort, reload])

  const loadMore = async () => {
    setLoadingMore(true)
    try {
      const response = await getMedia({ limit: PAGE_SIZE, offset: items.length, with_counts: true, ...query })
      setItems((prev) => [...prev, ...response.data.filter((m) => !prev.some((p) => p.id === m.id))])
      setTotal(response.meta?.total ?? total)
    } catch (e) {
      // Keep what's already loaded on screen; the button stays for a retry.
      toast.error(errorMessage(e, "Failed to load more media"))
    } finally {
      setLoadingMore(false)
    }
  }

  // Same fields as before the redesign: the file name as the name, its stem as the alt
  // text (editable afterwards), and a description naming the file.
  const upload = async (files: File[]) => {
    if (files.length === 0) return
    const batch = files.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, name: file.name, error: null }))
    setUploads((prev) => [...batch, ...prev.filter((u) => u.error === null)])
    const results = await Promise.allSettled(
      files.map((file) => {
        const form = new FormData()
        form.append("file", file)
        form.append("name", file.name)
        form.append("description", `Uploaded file: ${file.name}`)
        form.append("alt", file.name.split(".")[0])
        return createMedia(form)
      })
    )
    const failed = new Map<string, string>()
    results.forEach((r, i) => {
      if (r.status === "rejected") failed.set(batch[i].key, errorMessage(r.reason, "Upload failed"))
    })
    const done = results.length - failed.size
    // Uploaded tiles give way to the real ones; failed ones stay with the reason.
    setUploads((prev) =>
      prev.flatMap((u) => {
        if (!batch.some((b) => b.key === u.key)) return [u]
        return failed.has(u.key) ? [{ ...u, error: failed.get(u.key)! }] : []
      })
    )
    if (done > 0) {
      toast.success(`Uploaded ${done} file${done === 1 ? "" : "s"}${failed.size > 0 ? `, ${failed.size} failed` : ""}`)
      setReload((n) => n + 1)
    } else {
      toast.error(failed.size === 1 ? `Upload failed: ${[...failed.values()][0]}` : "All uploads failed")
    }
  }

  const chooseFiles = () => fileInput.current?.click()

  const onDragOver = (e: DragEvent) => {
    if (!canUpload || !e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragOver(true)
  }
  const onDrop = (e: DragEvent) => {
    if (!canUpload) return
    e.preventDefault()
    setDragOver(false)
    upload(Array.from(e.dataTransfer.files))
  }

  const open = openId !== null ? (items.find((m) => m.id === openId) ?? null) : null
  const setOpen = (media: MediaItem | null) => setParam("file", media ? String(media.id) : "", "")

  const replaceItem = (media: MediaItem) => setItems((prev) => prev.map((m) => (m.id === media.id ? media : m)))

  const removeItems = (ids: number[]) => {
    setItems((prev) => prev.filter((m) => !ids.includes(m.id)))
    setTotal((n) => Math.max(0, n - ids.length))
    setSelected((prev) => prev.filter((m) => !ids.includes(m.id)))
    if (openId !== null && ids.includes(openId)) setOpen(null)
  }

  const toggleSelect = (media: MediaItem) =>
    setSelected((prev) => (prev.some((m) => m.id === media.id) ? prev.filter((m) => m.id !== media.id) : [...prev, media]))

  const stopSelecting = () => {
    setSelecting(false)
    setSelected([])
  }

  const hasFilters = !!(search || type)
  const libraryEmpty = !loading && !error && items.length === 0 && !hasFilters && uploads.length === 0

  const empty = hasFilters ? (
    <EmptyState
      icon="search"
      title="No media matches these filters"
      description="Try another type or search, or clear the filters."
      action={
        <Button
          variant="secondary"
          onClick={() => {
            setSearchText("")
            const next = new URLSearchParams(params)
            next.delete("q")
            next.delete("type")
            setSearchParams(next, { replace: true })
          }}
        >
          Clear filters
        </Button>
      }
    />
  ) : (
    <div className={`gl-media-dropzone${dragOver ? " is-over" : ""}`}>
      <span className="gl-media-dropzone__icon" aria-hidden="true">
        <UploadIcon size={24} />
      </span>
      <div className="gl-media-dropzone__text">
        <h2>{canUpload ? "Drop files here to upload" : "No media yet"}</h2>
        <p>
          {canUpload
            ? "Images, video, audio and documents (PDF, DOC, TXT), up to 50 MB each. Anything you upload can be used in any post or page."
            : "Nothing has been uploaded yet. Your role can't upload media; ask an administrator."}
        </p>
      </div>
      {canUpload && (
        <Button variant="primary" size="lg" onClick={chooseFiles}>
          Choose files
        </Button>
      )}
    </div>
  )

  const writable = (media: MediaItem) => canWriteMedia(user, media)

  return (
    <div className={`gl-media-page${open && !asDrawer ? " has-panel" : ""}`}>
      <div
        className={`gl-media${dragOver && !libraryEmpty ? " is-drag-over" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
        }}
        onDrop={onDrop}
      >
        <header className="gl-media__header">
          <h1>Media</h1>
          {!loading && !error && <span className="gl-media__count">{countLine(total)}</span>}
          <div className="gl-media__spacer" />
          {canUpload && (
            <Button variant="primary" icon={<UploadIcon />} onClick={chooseFiles}>
              Upload
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            aria-label="Files to upload"
            onChange={(e) => {
              upload(Array.from(e.currentTarget.files ?? []))
              e.currentTarget.value = ""
            }}
          />
        </header>

        {!libraryEmpty &&
          (selecting ? (
            <div className="gl-media__toolbar gl-media__bulk" role="toolbar" aria-label="Selection">
              <span className="gl-media__bulk-count" aria-live="polite">
                {selected.length} selected
              </span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(items)} disabled={selected.length === items.length}>
                Select all {items.length}
              </Button>
              <div className="gl-media__spacer" />
              <Button
                variant="danger"
                size="sm"
                disabled={selected.length === 0 || !selected.every(writable)}
                title={selected.every(writable) ? undefined : "You can only delete files you uploaded"}
                onClick={() => setToDelete(selected)}
              >
                Delete
              </Button>
              <Button variant="secondary" size="sm" onClick={stopSelecting}>
                Done
              </Button>
            </div>
          ) : (
            <div className="gl-media__toolbar">
              <label className="gl-media__search">
                <SearchIcon />
                <span className="gl-media-sr">Search media</span>
                <input
                  type="search"
                  placeholder="Search by name or alt text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.currentTarget.value)}
                />
              </label>
              <fieldset className="gl-segmented">
                <legend className="gl-media-sr">File type</legend>
                {TYPE_FILTERS.map((t) => (
                  <label key={t.id || "all"} className={`gl-segmented__option${type === t.id ? " is-checked" : ""}`}>
                    <input
                      type="radio"
                      name="media-type"
                      value={t.id}
                      checked={type === t.id}
                      onChange={() => setParam("type", t.id, "")}
                    />
                    {t.label}
                  </label>
                ))}
              </fieldset>
              <div className="gl-media__spacer" />
              <FilterSelect
                prefix="Sort"
                options={MEDIA_SORTS}
                value={sort}
                onChange={(value) => setParam("sort", value, "date_desc")}
              />
              {items.length > 0 && (
                <Button variant="secondary" onClick={() => setSelecting(true)}>
                  Select
                </Button>
              )}
            </div>
          ))}

        <MediaGrid
          mediaItems={items}
          loading={loading}
          error={error}
          onRetry={() => setReload((n) => n + 1)}
          uploads={uploads}
          empty={empty}
          selectable={selecting}
          selectedMedia={selected}
          onMediaSelect={toggleSelect}
          activeId={openId}
          onMediaClick={(media) => setOpen(media.id === openId ? null : media)}
        />

        {!loading && !error && items.length > 0 && (
          <div className="gl-media__more">
            <span className="gl-media__more-info">
              Showing {items.length} of {total}
            </span>
            {items.length < total && (
              <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
                Load more
              </Button>
            )}
          </div>
        )}
      </div>

      {open && (
        <MediaPanel
          key={open.id}
          media={open}
          canWrite={writable(open)}
          asDrawer={asDrawer}
          onClose={() => setOpen(null)}
          onUpdated={replaceItem}
          onDelete={(media) => setToDelete([media])}
        />
      )}

      <DeleteMediaDialog
        media={toDelete}
        onClose={() => setToDelete([])}
        onDeleted={(ids) => {
          removeItems(ids)
          if (selecting && ids.length === selected.length) stopSelecting()
        }}
      />
    </div>
  )
}
