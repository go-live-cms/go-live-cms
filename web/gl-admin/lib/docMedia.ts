import { useEffect, useState } from "react"
import { getMediaURL } from "./api"
import { lookupMedia } from "./mediaLookup"
import type { BlockDocV1 } from "./blocks-spec"

// The admin renders stored block docs with the public `BlockRenderer` (History's preview and
// comparison, #136, #355), from REST reads that don't carry the API's `media` map. A video,
// audio or file block (#423), and a cover or media & text (#427), render from that map alone
// (the URL, type, size, an image's variants), so this adds those entries, and `media_missing`,
// from the editor's media lookups (`mediaLookup.ts`): the same answers the editor's own views
// show. Images keep rendering from their src.

type DocWithMedia = BlockDocV1 & { media?: Record<string, unknown>; media_missing?: number[] }

const FILE_BLOCK_TYPES = new Set(["video", "audio", "file", "cover", "media_text"])

/** The media ids of the doc's video, audio and file blocks, each once. */
export function fileBlockMediaIds(doc: BlockDocV1 | null | undefined): number[] {
  const ids = new Set<number>()
  for (const block of Object.values(doc?.blocks ?? {})) {
    const id = (block?.attrs as { mediaId?: unknown } | undefined)?.mediaId
    if (FILE_BLOCK_TYPES.has(block?.type) && typeof id === "number" && Number.isInteger(id) && id > 0) ids.add(id)
  }
  return [...ids]
}

/** `doc` with the media entries its file blocks need (a new object; `doc` is left as is). */
export async function withFileBlockMedia<T extends BlockDocV1>(doc: T): Promise<T> {
  const ids = fileBlockMediaIds(doc)
  if (ids.length === 0) return doc
  const results = await Promise.all(ids.map((id) => lookupMedia(id)))
  const media: Record<string, unknown> = { ...((doc as DocWithMedia).media ?? {}) }
  const missing: number[] = []
  results.forEach((result, i) => {
    if (result.status === "missing") missing.push(ids[i])
    if (result.status !== "found") return
    const m = result.media
    media[String(ids[i])] = {
      media_path: getMediaURL(m.media_path),
      width: m.width ?? 0,
      height: m.height ?? 0,
      mime_type: m.mime_type,
      file_size: m.file_size,
      name: m.name,
      filename: m.original_filename,
      variants: m.variants,
      focal_point: m.focal_point,
      decorative: m.decorative,
    }
  })
  return { ...doc, media, ...(missing.length > 0 ? { media_missing: missing } : {}) }
}

/** `doc`, then `doc` with its file blocks' media once looked up. */
export function useFileBlockMedia<T extends BlockDocV1>(doc: T): T {
  const [shown, setShown] = useState<{ source: T; doc: T }>({ source: doc, doc })
  useEffect(() => {
    let live = true
    setShown({ source: doc, doc })
    if (fileBlockMediaIds(doc).length === 0) return
    void withFileBlockMedia(doc).then((next) => live && setShown({ source: doc, doc: next }))
    return () => {
      live = false
    }
  }, [doc])
  return shown.source === doc ? shown.doc : doc
}
