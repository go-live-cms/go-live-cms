import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  fileMetaLine,
  fileTypeTag,
  FILE_LABEL_MAX_LENGTH,
  formatFileSize,
  isMediaBlockType,
  isMediaMissing,
  MEDIA_BLOCK_KINDS,
  MEDIA_BLOCK_TYPES,
  MEDIA_PICKER_KINDS,
  mimeMatchesKind,
  normalizeFileLabel,
} from "./media"

// The media blocks' shared rules (#423), used by the editor, the collab server and the
// public renderer.

describe("media blocks (#423)", () => {
  it("map each media block to the picker kind it takes", () => {
    expect(MEDIA_BLOCK_KINDS).toEqual({ image: "image", video: "video", audio: "audio", file: "document" })
    expect(MEDIA_BLOCK_TYPES).toEqual(["image", "video", "audio", "file"])
    expect(MEDIA_PICKER_KINDS).toEqual(["image", "video", "audio", "document"])
    expect(isMediaBlockType("video")).toBe(true)
    expect(isMediaBlockType("toString")).toBe(false)
  })

  it("match MIME types to kinds by the API's prefixes", () => {
    expect(mimeMatchesKind("video/mp4", "video")).toBe(true)
    expect(mimeMatchesKind("audio/mpeg", "audio")).toBe(true)
    expect(mimeMatchesKind("application/pdf", "document")).toBe(true)
    expect(mimeMatchesKind("image/png", "video")).toBe(false)
    expect(mimeMatchesKind("", "image")).toBe(false)
    expect(mimeMatchesKind(undefined, "document")).toBe(false)
  })

  it("agree with the API on which blocks show media and on the label's cap", () => {
    const go = readFileSync(path.resolve("../api/post_block_media.go"), "utf8")
    expect(go).toMatch(/mediaBlockTypes = map\[string\]bool\{"image": true, "video": true, "audio": true, "file": true\}/)
    const sanitizer = readFileSync(path.resolve("../api/post_blocks_sanitize.go"), "utf8")
    expect(sanitizer).toContain(`const fileLabelMaxRunes = ${FILE_LABEL_MAX_LENGTH}`)
  })

  it("normalize a file label like a citation: plain, trimmed, capped, null when empty", () => {
    expect(normalizeFileLabel("  Import checklist ")).toBe("Import checklist")
    expect(normalizeFileLabel("a\u0000b\nc")).toBe("a b c")
    expect(normalizeFileLabel("   ")).toBeNull()
    expect(normalizeFileLabel(42)).toBeNull()
    expect([...normalizeFileLabel("é".repeat(FILE_LABEL_MAX_LENGTH + 10))!]).toHaveLength(FILE_LABEL_MAX_LENGTH)
  })

  it("write a file's type and size as the canvas does ('PDF · 240 KB')", () => {
    expect(fileMetaLine("import-checklist.pdf", 240 * 1024)).toBe("PDF · 240 KB")
    expect(fileMetaLine("notes.docx", 1.4 * 1024 * 1024)).toBe("DOCX · 1.4 MB")
    expect(fileMetaLine("README", 0)).toBe("FILE")
    expect(fileTypeTag("/uploads/media/x-0123.MP4")).toBe("MP4")
    expect(fileTypeTag("odd.<script>")).toBe("FILE")
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(undefined)).toBe("")
  })

  it("tell a deleted media (media_missing) from one the doc simply has no entry for", () => {
    const doc = { media_missing: [12, 40] }
    expect(isMediaMissing(doc, 12)).toBe(true)
    expect(isMediaMissing(doc, "40")).toBe(true)
    expect(isMediaMissing(doc, 13)).toBe(false)
    // A failed lookup: no media_missing at all, so nothing is missing.
    expect(isMediaMissing({}, 12)).toBe(false)
    expect(isMediaMissing({ media_missing: "12" }, 12)).toBe(false)
    expect(isMediaMissing(null, 12)).toBe(false)
  })
})
