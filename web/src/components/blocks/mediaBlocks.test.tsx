import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"
import { uploadsUrl } from "./utils/mediaFile"

// Video, audio and file on the public page (#423, "Published · media & embeds"): the
// browser's own players with controls and no autoplay, a download row with the type and
// size, files only from /uploads (the API's media map, never the block), and a block whose
// media was deleted (`media_missing`) left out with its caption, the image's too. A failed
// lookup (no media map at all) is not a deleted file: an image still renders from its src.

const VIDEO = "blk-0423-video-00001"
const AUDIO = "blk-0423-audio-00001"
const FILE = "blk-0423-file-000001"
const IMAGE = "blk-0423-image-00001"
const GROUP = "blk-0423-group-00001"
const INNER = "blk-0423-inner-00001"

const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}) })

type Doc = BlockDocV1 & { media?: Record<string, unknown>; media_missing?: number[] }

const MEDIA = {
  "12": { media_path: "/uploads/media/launch-0a1b.mp4", width: 0, height: 0, mime_type: "video/mp4", file_size: 18_874_368, name: "Launch walkthrough", filename: "launch-walkthrough.mp4" },
  "13": { media_path: "/uploads/media/episode-12-ffee.mp3", width: 0, height: 0, mime_type: "audio/mpeg", file_size: 23_068_672, name: "Episode 12", filename: "episode-12.mp3" },
  "14": { media_path: "/uploads/media/checklist-9a9a.pdf", width: 0, height: 0, mime_type: "application/pdf", file_size: 245_760, name: "import-checklist.pdf", filename: "import-checklist.pdf" },
  "20": { media_path: "/uploads/media/cabin.jpg", width: 1500, height: 1000 },
}

function doc(extra: Partial<Doc> = {}): Doc {
  return {
    doc_version: 1,
    blocks_order: [VIDEO, AUDIO, FILE, IMAGE, GROUP],
    blocks: {
      [VIDEO]: { id: VIDEO, type: "video", version: 1, attrs: { mediaId: 12, caption: [t("The launch "), t("walkthrough", "italic")] } },
      [AUDIO]: { id: AUDIO, type: "audio", version: 1, attrs: { mediaId: 13 } },
      [FILE]: { id: FILE, type: "file", version: 1, attrs: { mediaId: 14, label: "GoLive import checklist" } },
      [IMAGE]: { id: IMAGE, type: "image", version: 2, attrs: { mediaId: 20, src: "/uploads/media/cabin.jpg", alt: "A cabin", caption: [t("Shot for the cover")] } },
      [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [INNER] },
      [INNER]: { id: INNER, type: "file", version: 1, attrs: { mediaId: 14 } },
    },
    media: MEDIA,
    ...extra,
  }
}

const html = (d: Doc) => renderToStaticMarkup(<BlockRenderer doc={d} />)

describe("video and audio (#423)", () => {
  it("render the browser's player with controls, nothing preloaded, never autoplaying, and the caption", () => {
    const out = html(doc())
    expect(out).toContain(
      `<figure id="b-${VIDEO}" class="video-block"><video controls="" preload="none" playsInline="" src="/uploads/media/launch-0a1b.mp4" aria-label="The launch walkthrough">`,
    )
    expect(out).toContain(`<figcaption>The launch <em>walkthrough</em></figcaption></figure>`)
    // No caption: the media's name names the player.
    expect(out).toContain(`<figure id="b-${AUDIO}" class="audio-block"><audio controls="" preload="none" src="/uploads/media/episode-12-ffee.mp3" aria-label="Episode 12">`)
    expect(out).not.toMatch(/autoplay/i)
    // A browser that can't play it gets a download link, under the uploaded name.
    expect(out).toContain(`<a href="/uploads/media/launch-0a1b.mp4" download="launch-walkthrough.mp4">Download the video</a>`)
  })
})

describe("file (#423)", () => {
  it("renders a download row with the label, the type and size, and a Download button", () => {
    const out = html(doc())
    expect(out).toContain(`<div id="b-${FILE}" class="file-block"><span class="file-icon" aria-hidden="true"><svg`)
    expect(out).toContain(
      `<div class="file-text"><a href="/uploads/media/checklist-9a9a.pdf" download="import-checklist.pdf">GoLive import checklist</a><span class="file-meta">PDF · 240 KB</span></div>`,
    )
    expect(out).toContain(
      `<a href="/uploads/media/checklist-9a9a.pdf" download="import-checklist.pdf" class="btn btn-secondary file-download" aria-label="Download GoLive import checklist, PDF · 240 KB">Download</a>`,
    )
  })

  it("defaults the link text to the media's name, inside a group too", () => {
    const out = html(doc())
    expect(out).toContain(`<div id="b-${GROUP}" class="group"><div class="file-block">`)
    expect(out).toContain(`download="import-checklist.pdf">import-checklist.pdf</a>`)
  })
})

describe("where the files come from (#423)", () => {
  it("only /uploads paths, from the API's media map, never the block's own attrs", () => {
    const d = doc()
    ;(d.blocks[VIDEO].attrs as any).src = "https://evil.example/x.mp4"
    expect(html(d)).not.toContain("evil.example")
    for (const bad of ["https://evil.example/x.mp4", "//evil.example/x", "javascript:alert(1)", "/uploads/../app.env", "/uploads/a b.mp4", "/uploads/x?y", "/other/x.mp4", "/uploads\\x"]) {
      expect(uploadsUrl(bad), bad).toBeUndefined()
      const out = html(doc({ media: { ...MEDIA, "12": { ...MEDIA["12"], media_path: bad } } }))
      expect(out, bad).not.toContain(`id="b-${VIDEO}"`)
    }
    expect(uploadsUrl("/uploads/media/x.mp4")).toBe("/uploads/media/x.mp4")
  })

  it("renders nothing for a block without a file yet, or when the API couldn't look it up", () => {
    const empty = doc()
    empty.blocks[VIDEO].attrs = {}
    expect(html(empty)).not.toContain(`id="b-${VIDEO}"`)
    const failed = doc({ media: undefined })
    const out = html(failed)
    expect(out).not.toContain("<video")
    expect(out).not.toContain("file-block")
    // The image still renders from its src.
    expect(out).toContain(`src="/uploads/media/cabin.jpg"`)
  })
})

describe("missing media (#423, 'A media file that's missing')", () => {
  it("leaves a block whose media was deleted out, with its caption", () => {
    const out = html(doc({ media: { "13": MEDIA["13"] }, media_missing: [12, 14, 20] }))
    expect(out).not.toContain("<video")
    expect(out).not.toContain("The launch")
    expect(out).not.toContain("file-block")
    expect(out).not.toContain("cabin.jpg")
    expect(out).not.toContain("Shot for the cover")
    // The rest of the post is there.
    expect(out).toContain("<audio")
  })
})
