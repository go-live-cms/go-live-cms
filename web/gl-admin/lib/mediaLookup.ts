import { getMediaById, createMedia } from "./api/media"
import { ApiError } from "./api/errors"
import type { Media } from "./api/types"

// The editor's view of the media its blocks show (#423). A media block stores only a
// media id, so its view asks the library for the file (name, URL, size) and learns that
// way whether it still exists:
//
// - `found`: the media, from `GET /media/:id` or from the picker that just chose it;
// - `missing`: the API answered 404 (the media was deleted): the block shows "The file is
//   missing" with Replace, as the public page leaves it out (`media_missing`);
// - `unknown`: any other failure (offline, a 5xx). Not cached, and not shown as missing:
//   a failed lookup is not a deleted file, so the block shows what it can.
//
// One lookup per media id, shared by every block showing it. Memory only (rule 0's
// spirit: nothing about a post survives a reload outside the server).

export type MediaLookup = { status: "found"; media: Media } | { status: "missing" } | { status: "unknown" }

const lookups = new Map<number, Promise<MediaLookup>>()
const known = new Map<number, MediaLookup>()

/** The lookup already settled for `id` (to render without a flash), else undefined. */
export function knownMedia(id: number): MediaLookup | undefined {
  return known.get(id)
}

/** Looks media `id` up once (every later call shares the answer, except an `unknown` one). */
export function lookupMedia(id: number): Promise<MediaLookup> {
  const pending = lookups.get(id)
  if (pending) return pending
  const lookup = getMediaById(id)
    .then(({ media }): MediaLookup => (media ? { status: "found", media } : { status: "unknown" }))
    .catch((error): MediaLookup => (error instanceof ApiError && error.status === 404 ? { status: "missing" } : { status: "unknown" }))
    .then((result) => {
      if (result.status === "unknown") lookups.delete(id)
      else known.set(id, result)
      return result
    })
  lookups.set(id, lookup)
  return lookup
}

/** Records media the admin already has (picked or uploaded), so its blocks show it at once. */
export function rememberMedia(media: Media) {
  const result: MediaLookup = { status: "found", media }
  known.set(media.id, result)
  lookups.set(media.id, Promise.resolve(result))
}

/** Forgets every lookup (tests). */
export function resetMediaLookups() {
  lookups.clear()
  known.clear()
}

/**
 * Uploads one file to the media library, as the library's own Upload does (`pages/Media.tsx`):
 * the file name as the name, a description naming the file, and no alt text (#325: the
 * image is flagged "No alt text" until someone writes one). Remembered for the lookups.
 */
export async function uploadMediaFile(file: File): Promise<Media> {
  const form = new FormData()
  form.append("file", file)
  form.append("name", file.name)
  form.append("description", `Uploaded file: ${file.name}`)
  const response = await createMedia(form)
  const media = response?.media as Media | undefined
  if (!media || typeof media.id !== "number") throw new Error("Upload failed")
  rememberMedia(media)
  return media
}
