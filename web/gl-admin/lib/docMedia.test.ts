import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "./blocks-spec"
import { ApiError } from "./api/errors"
import { fileBlockMediaIds, withFileBlockMedia } from "./docMedia"
import { resetMediaLookups } from "./mediaLookup"

// History's preview renders stored docs with the public renderer (#423): video, audio and
// file blocks need the media map the API attaches to public reads, so the admin fills it
// from its media lookups, with media_missing for deleted ones.

const api = vi.hoisted(() => ({ getMediaById: vi.fn() }))
vi.mock("./api/media", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api/media")>()), getMediaById: api.getMediaById }))

const doc: BlockDocV1 = {
  doc_version: 1,
  blocks_order: ["video-00001", "file-000001", "image-00001", "gone-000001"],
  blocks: {
    "video-00001": { id: "video-00001", type: "video", version: 1, attrs: { mediaId: 12 } },
    "file-000001": { id: "file-000001", type: "file", version: 1, attrs: { mediaId: 12 } },
    "image-00001": { id: "image-00001", type: "image", version: 2, attrs: { mediaId: 30, src: "/uploads/a.jpg" } },
    "gone-000001": { id: "gone-000001", type: "audio", version: 1, attrs: { mediaId: 99 } },
  },
}

beforeEach(() => {
  resetMediaLookups()
  api.getMediaById.mockReset()
  api.getMediaById.mockImplementation(async (id: number) => {
    if (Number(id) === 99) throw new ApiError("Not found.", 404)
    return { media: { id: 12, name: "Launch", media_path: "/uploads/media/l.mp4", mime_type: "video/mp4", file_size: 9, original_filename: "launch.mp4" } }
  })
})

describe("the History preview's media map (#423)", () => {
  it("looks up each file block's media once, images left alone", async () => {
    expect(fileBlockMediaIds(doc)).toEqual([12, 99])
    const out = (await withFileBlockMedia(doc)) as any
    expect(api.getMediaById).toHaveBeenCalledTimes(2)
    expect(out.media["12"]).toMatchObject({ media_path: "/uploads/media/l.mp4", mime_type: "video/mp4", name: "Launch", filename: "launch.mp4" })
    expect(out.media["30"]).toBeUndefined()
    expect(out.media_missing).toEqual([99])
    expect((doc as any).media).toBeUndefined()
  })

  it("fills a cover's and media & text's entry too, with what the renderer needs for an image (#427)", async () => {
    const withImage: BlockDocV1 = {
      doc_version: 1,
      blocks_order: ["cover-00001", "media-00001"],
      blocks: {
        "cover-00001": { id: "cover-00001", type: "cover", version: 1, attrs: { mediaId: 12 } },
        "media-00001": { id: "media-00001", type: "media_text", version: 1, attrs: { mediaId: 99 } },
      },
    }
    api.getMediaById.mockImplementation(async (id: number) => {
      if (Number(id) === 99) throw new ApiError("Not found.", 404)
      return { media: { id: 12, media_path: "/uploads/media/t.jpg", width: 1500, height: 1000, variants: { thumb: { path: "/uploads/t.jpg", width: 1, height: 1 } }, focal_point: { x: 0.5, y: 0.4 }, decorative: true } }
    })
    expect(fileBlockMediaIds(withImage)).toEqual([12, 99])
    const out = (await withFileBlockMedia(withImage)) as any
    expect(out.media["12"]).toMatchObject({ media_path: "/uploads/media/t.jpg", width: 1500, focal_point: { x: 0.5, y: 0.4 }, decorative: true })
    expect(out.media["12"].variants.thumb.path).toBe("/uploads/t.jpg")
    expect(out.media_missing).toEqual([99])
  })

  it("leaves a doc without file blocks as it is", async () => {
    const plain: BlockDocV1 = { doc_version: 1, blocks_order: [], blocks: {} }
    expect(await withFileBlockMedia(plain)).toBe(plain)
    expect(api.getMediaById).not.toHaveBeenCalled()
  })
})