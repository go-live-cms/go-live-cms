import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { getMediaURL } from "@gl-admin/lib/api"
import { MEDIA_BLOCK_KINDS, type MediaPickerKind } from "@gl-admin/lib/blocks-spec"
import { knownMedia, rememberMedia, uploadMediaFile } from "@gl-admin/lib/mediaLookup"
import type { Media } from "@gl-admin/lib/api/types"
import { blockSpecTypeOf, refOfBlock, resolveEditorBlock, type BlockRef } from "../utils/blockTree"

// Choosing the file of a media block (#423): Choose from Media, Upload and Replace, from the
// block's view, its toolbar and the settings panel. The editor's views are plain DOM (no
// React), so they ask for the picker here, and the editor's `MediaPickerHost` (one per
// editor) shows the shared `MediaPicker`. The block is found again **by its id** when the
// file is chosen (a collaborator may have moved it meanwhile), and changed with one
// ordinary transaction (`setBlockMedia`): no appendTransaction, nothing around the editor
// (rules 7 and 11).

export interface MediaPickRequest {
  kind: MediaPickerKind
  /** The file the block shows now (Replace), marked in the picker. */
  current?: Media | null
  onPick: (media: Media) => void
  /** Several files at once (a gallery's Add images, #424), in the order they were chosen. */
  multiple?: boolean
  onPickMany?: (media: Media[]) => void
}

export interface MediaPickerHostHandlers {
  /** Shows the picker. */
  open: (request: MediaPickRequest) => void
  /** Called after a block took `media` (picked or uploaded): links it to the post. */
  applied?: (media: Media) => void
}

const hosts = new WeakMap<Editor, MediaPickerHostHandlers>()

/** Called by `MediaPickerHost`; returns the unregister function. */
export function registerMediaPickerHost(editor: Editor, host: MediaPickerHostHandlers): () => void {
  hosts.set(editor, host)
  return () => {
    if (hosts.get(editor) === host) hosts.delete(editor)
  }
}

/** Opens the picker for `editor`; false when no host is mounted (a read-only view). */
export function requestMediaPick(editor: Editor, request: MediaPickRequest): boolean {
  const host = hosts.get(editor)
  if (!host) return false
  host.open(request)
  return true
}

/** The picker kind of a media node ("file" → "document"). */
export function mediaKindOfNode(node: PMNode): MediaPickerKind | null {
  const type = blockSpecTypeOf(node.type.name)
  return (MEDIA_BLOCK_KINDS as Record<string, MediaPickerKind>)[type] ?? null
}

/** An image block's attrs from its media: the URL, alt text (a decorative image gets none, #325), name and id. */
function imageAttrsOf(media: Media) {
  return {
    src: getMediaURL(media.media_path),
    alt: media.decorative ? "" : media.alt?.trim() || "",
    title: media.name || "",
    mediaId: media.id,
  }
}

/**
 * Points the block `ref` names at `media`, in one transaction. An image also takes the
 * media's URL, alt text and name, as before #423 (`MediaBlockManager`): its caption and
 * width stay, the media's description isn't copied anywhere, and a decorative image gets an
 * empty alt (#325). A file block keeps its label (none shows the file's name). The host is
 * told (it links the media to the post), whether the file was picked or uploaded. False when
 * the block is gone or isn't a media block any more.
 */
export function applyMediaToBlock(editor: Editor, ref: BlockRef, media: Media): boolean {
  if (!editor.isEditable) return false
  const block = resolveEditorBlock(editor.state.doc, ref)
  if (!block || !mediaKindOfNode(block.node)) return false
  rememberMedia(media)
  if (block.node.type.name === "image") {
    const tr = editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, ...imageAttrsOf(media) })
    editor.view.dispatch(tr)
    hosts.get(editor)?.applied?.(media)
    return true
  }
  const applied = editor.commands.setBlockMedia(block.pos, media.id)
  if (applied) hosts.get(editor)?.applied?.(media)
  return applied
}

/** The block's current media when already looked up (for the picker's mark). */
function currentMedia(node: PMNode): Media | null {
  const id = node.attrs.mediaId
  const known = typeof id === "number" ? knownMedia(id) : undefined
  return known?.status === "found" ? known.media : null
}

/** Opens the picker for the media block at `pos` (Choose from Media, Replace). */
export function chooseMediaFor(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos)
  const kind = node ? mediaKindOfNode(node) : null
  if (!node || !kind || !editor.isEditable) return false
  const ref = refOfBlock({ node, pos })
  return requestMediaPick(editor, { kind, current: currentMedia(node), onPick: (media) => applyMediaToBlock(editor, ref, media) })
}

/**
 * Adds `media` to the gallery `ref` names, at its end, as image blocks in one transaction, so
 * collaborators get one update and one undo step takes them all back (#424). Each is an
 * ordinary image block with the media's alt text and name. The host links each to the post.
 */
export function addMediaToGallery(editor: Editor, ref: BlockRef, media: Media[]): boolean {
  if (!editor.isEditable || media.length === 0) return false
  const block = resolveEditorBlock(editor.state.doc, ref)
  if (!block || block.node.type.name !== "gallery") return false
  media.forEach(rememberMedia)
  const added = editor.commands.addGalleryImages(block.pos, media.map(imageAttrsOf))
  if (added) media.forEach((item) => hosts.get(editor)?.applied?.(item))
  return added
}

/** Opens the picker for the gallery at `pos` (Add images): several images at once. */
export function chooseGalleryImages(editor: Editor, pos: number): boolean {
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== "gallery" || !editor.isEditable) return false
  const ref = refOfBlock({ node, pos })
  return requestMediaPick(editor, {
    kind: "image",
    multiple: true,
    onPick: (media) => addMediaToGallery(editor, ref, [media]),
    onPickMany: (media) => addMediaToGallery(editor, ref, media),
  })
}

/**
 * Uploads `files` and adds them to the gallery at `pos` (its own Upload), found again by id
 * after the uploads. What uploaded before a failure is added; rejects with the failure.
 */
export async function uploadGalleryImages(editor: Editor, pos: number, files: File[]): Promise<Media[]> {
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== "gallery") throw new Error("This block can't hold images")
  const ref = refOfBlock({ node, pos })
  const uploaded: Media[] = []
  try {
    for (const file of files) uploaded.push(await uploadMediaFile(file))
  } finally {
    addMediaToGallery(editor, ref, uploaded)
  }
  return uploaded
}

/**
 * Uploads `file` and points the block at `pos` at it (the block's own Upload). The block is
 * found again by id after the upload. Rejects with the upload's error.
 */
export async function uploadMediaFor(editor: Editor, pos: number, file: File): Promise<Media> {
  const node = editor.state.doc.nodeAt(pos)
  if (!node || !mediaKindOfNode(node)) throw new Error("This block can't hold a file")
  const ref = refOfBlock({ node, pos })
  const media = await uploadMediaFile(file)
  applyMediaToBlock(editor, ref, media)
  return media
}
