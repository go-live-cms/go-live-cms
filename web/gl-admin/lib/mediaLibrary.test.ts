import { describe, expect, it } from "vitest"
import {
  countLine,
  findMediaSort,
  focalObjectPosition,
  formatDuration,
  formatFileSize,
  formatTag,
  mediaKind,
  mediaMetaLine,
  replaceHint,
  typeLabel,
  usedInHeading,
  usedInRows,
  type MediaPostLink,
} from "./mediaLibrary"

const link = (id: number, relationship: string, over: Partial<MediaPostLink["post"]> = {}): MediaPostLink => ({
  post: { id, title: `Post ${id}`, post_type: "post", post_status: "published", ...over },
  media_order: relationship === "featured" ? 0 : 1,
  relationship_type: relationship,
})

describe("usedInRows (the “Used in” data)", () => {
  it("names how each post uses the file", () => {
    expect(usedInRows([link(1, "featured"), link(2, "gallery", { post_status: "draft" })])).toEqual([
      { key: "1", postId: 1, title: "Post 1", how: "Featured image", status: "published" },
      { key: "2", postId: 2, title: "Post 2", how: "Image in the post", status: "draft" },
    ])
  })

  it("merges a post that uses it as featured image and in its body", () => {
    const rows = usedInRows([link(5, "featured"), link(5, "gallery"), link(5, "gallery")])
    expect(rows).toHaveLength(1)
    expect(rows[0].how).toBe("Featured image and Image in the post")
  })

  it("prefixes types other than post, and names untitled posts", () => {
    const [row] = usedInRows([link(3, "gallery", { post_type: "page", title: "" })])
    expect(row.how).toBe("Page · Image in the post")
    expect(row.title).toBe("Untitled")
  })

  it("is empty for an unused file", () => {
    expect(usedInRows([])).toEqual([])
  })

  it("headings and the Replace hint count places", () => {
    expect(usedInHeading(0)).toBe("Not used yet")
    expect(usedInHeading(1)).toBe("Used in 1 place")
    expect(usedInHeading(3)).toBe("Used in 3 places")
    expect(replaceHint(3)).toBe("The 3 places that use this file will show the new one. Name, description and alt text stay.")
    expect(replaceHint(1)).toMatch(/^The 1 place that uses/)
    expect(replaceHint(null)).toMatch(/^Posts that use this file/)
  })
})

describe("file kinds and labels", () => {
  it("goes by MIME type, then the extension", () => {
    expect(mediaKind({ media_path: "a.jpg", mime_type: "image/jpeg" })).toBe("image")
    expect(mediaKind({ media_path: "a.svg", mime_type: "image/svg+xml" })).toBe("vector")
    expect(mediaKind({ media_path: "a.webm", mime_type: "video/webm" })).toBe("video")
    expect(mediaKind({ media_path: "a.mp3", mime_type: "audio/mpeg" })).toBe("audio")
    expect(mediaKind({ media_path: "a.pdf", mime_type: "application/pdf" })).toBe("file")
    expect(mediaKind({ media_path: "uploads/x.PNG", mime_type: "" })).toBe("image")
  })

  it("tags with the format and describes the type", () => {
    expect(formatTag({ media_path: "uploads/2026/cover.jpeg" })).toBe("JPEG")
    expect(formatTag({ media_path: "uploads/README" })).toBe("FILE")
    expect(typeLabel({ media_path: "a.png", mime_type: "image/png" })).toBe("PNG image")
    expect(typeLabel({ media_path: "a.pdf", mime_type: "application/pdf" })).toBe("PDF file")
  })

  it("formats sizes, lengths and the tile's meta line", () => {
    expect(formatFileSize(0)).toBe("0 B")
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(412 * 1024)).toBe("412 KB")
    expect(formatFileSize(1.4 * 1024 * 1024)).toBe("1.4 MB")
    expect(formatDuration(135)).toBe("2:15")
    expect(formatDuration(0)).toBe("")
    expect(mediaMetaLine({ width: 2400, height: 1500, file_size: 412 * 1024 })).toBe("2400 × 1500 · 412 KB")
    expect(mediaMetaLine({ file_size: 96 * 1024 })).toBe("96 KB")
  })

  it("counts files and falls back to the newest sort", () => {
    expect(countLine(0)).toBe("No files yet")
    expect(countLine(1)).toBe("1 file")
    expect(countLine(214)).toBe("214 files")
    expect(findMediaSort("name_asc")).toBe("name_asc")
    expect(findMediaSort("bogus")).toBe("date_desc")
    expect(findMediaSort(null)).toBe("date_desc")
  })
})

describe("focalObjectPosition", () => {
  it("matches the public ImageBlock's object-position", () => {
    expect(focalObjectPosition({ x: 0.29, y: 0.6 })).toBe("29% 60%")
    expect(focalObjectPosition({ x: 0.3333, y: 1 })).toBe("33.3% 100%")
    expect(focalObjectPosition(null)).toBe("50% 50%")
  })
})
