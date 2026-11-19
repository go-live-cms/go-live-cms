import { describe, expect, it } from "vitest"
import type { Media } from "./api/types"
import {
  MAX_IMPORT_LINKS,
  addButtonLabel,
  failedLinks,
  importRequestError,
  importSummary,
  parseImportLinks,
  resultLine,
  shortLink,
  type ImportResult,
} from "./mediaImport"

// "Add from URL" (#29): reading the text box and wording the results.

const media = (name: string): Media => ({
  id: 1,
  name,
  description: "",
  alt: "",
  media_path: `/uploads/media/${name}`,
  user_id: 1,
  created_at: "",
  changed_at: "",
  file_size: 1,
  mime_type: "image/jpeg",
  original_filename: name,
})

describe("parseImportLinks", () => {
  it("reads one link per line, skipping blank lines and repeats", () => {
    expect(parseImportLinks("")).toEqual({ links: [], problem: null })
    expect(parseImportLinks("  https://a.example/x.jpg  \n\n http://b.example/y.pdf\r\nhttps://a.example/x.jpg\n")).toEqual({
      links: ["https://a.example/x.jpg", "http://b.example/y.pdf"],
      problem: null,
    })
  })

  it("names the first line that isn't an http(s) link", () => {
    expect(parseImportLinks("https://a.example/x.jpg\nexample.com/clip.mp4\nhttps://c.example/z")).toEqual({
      links: ["https://a.example/x.jpg", "https://c.example/z"],
      problem: "Line 2 isn't a link starting with http:// or https://.",
    })
    expect(parseImportLinks("ftp://a.example/x").problem).toContain("Line 1")
    expect(parseImportLinks("javascript:alert(1)").problem).toContain("Line 1")
    expect(parseImportLinks("\n\nfile:///etc/passwd").problem).toContain("Line 3")
  })

  it("refuses more than the API takes, and too-long links", () => {
    const many = Array.from({ length: MAX_IMPORT_LINKS + 2 }, (_, i) => `https://a.example/${i}.jpg`).join("\n")
    expect(parseImportLinks(many).problem).toBe("Add up to 10 links at a time (you have 12).")
    expect(parseImportLinks(`https://a.example/${"a".repeat(2048)}`).problem).toBe("Line 1 is too long for a link.")
  })
})

describe("wording", () => {
  it("labels the button by the links to add", () => {
    expect(addButtonLabel(0)).toBe("Add files")
    expect(addButtonLabel(1)).toBe("Add 1 file")
    expect(addButtonLabel(3)).toBe("Add 3 files")
  })

  it("shortens a link to its host and path", () => {
    expect(shortLink("https://images.example.com/photo.jpg?token=s3cret#x")).toBe("images.example.com/photo.jpg")
    expect(shortLink("https://example.com/")).toBe("example.com")
    expect(shortLink("not a link")).toBe("not a link")
  })

  it("summarizes the results, one line per link", () => {
    const results: ImportResult[] = [
      { url: "https://a.example/photo.jpg", status: "added", media: media("photo.jpg") },
      { url: "https://a.example/big.mp4", status: "failed", code: "too_large", error: "The file is larger than 50MB" },
    ]
    expect(importSummary(results)).toBe("1 added, 1 failed")
    expect(importSummary(results.slice(0, 1))).toBe("1 added")
    expect(importSummary(results.slice(1))).toBe("1 failed")
    expect(resultLine(results[0])).toBe("Added as photo.jpg")
    expect(resultLine(results[1])).toBe("The file is larger than 50MB")
    expect(failedLinks(results)).toEqual(["https://a.example/big.mp4"])
  })

  it("words a refused request", () => {
    expect(importRequestError(429, "x")).toBe("Too many imports. Try again in a minute.")
    expect(importRequestError(500, "Something went wrong")).toBe("Something went wrong")
  })
})
