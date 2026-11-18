import { describe, expect, it, vi } from "vitest"
import {
  altHint,
  altTextValue,
  countLine,
  findMediaSort,
  focalObjectPosition,
  formatDuration,
  formatFileSize,
  formatTag,
  mediaKind,
  mediaMetaLine,
  missingAlt,
  replaceHint,
  typeLabel,
  usedInHeading,
  usageLabels,
  canHaveCaptions,
  isCaptionsFile,
  usedInRows,
  allUsedInRows,
  deleteSiteDesignNotice,
  lookUpSiteDesignNames,
  SITE_DESIGN_CHECK_FAILED,
  siteDesignNames,
  siteDesignUsedInRows,
  siteTemplateName,
  type MediaPostLink,
  type MediaSiteTemplateUse,
  type MediaUsage,
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
    expect(rows[0].how).toBe("Featured image and image in the post")
  })

  it("prefixes types other than post, and names untitled posts", () => {
    const [row] = usedInRows([link(3, "gallery", { post_type: "page", title: "" })])
    expect(row.how).toBe("Page · Image in the post")
    expect(row.title).toBe("Untitled")
  })

  it("names the usage types (#176): featured image, blocks and attached links", () => {
    const featured: MediaUsage = { type: "featured" }
    const block = (id: string, block_type = "image"): MediaUsage => ({ type: "block", block_id: id, block_type })
    const rows = usedInRows([
      { ...link(1, "featured"), usages: [featured] },
      { ...link(2, "gallery"), usages: [block("a")] },
      { ...link(3, "featured"), usages: [featured, block("b"), block("c")] },
      { ...link(4, "gallery"), usages: [{ type: "attached" }] },
      { ...link(5, "gallery", { post_type: "page" }), usages: [block("d"), block("e", "theme:example/hero_banner")] },
    ])
    expect(rows.map((r) => r.how)).toEqual([
      "Featured image",
      "Image block",
      "Featured image and 2 image blocks",
      "Attached",
      "Page · Image block and hero banner block",
    ])
  })

  it("names the video, audio and file blocks (#423)", () => {
    const block = (id: string, block_type: string): MediaUsage => ({ type: "block", block_id: id, block_type })
    const rows = usedInRows([
      { ...link(1, "gallery"), usages: [block("a", "video")] },
      { ...link(2, "gallery"), usages: [block("b", "audio"), block("c", "audio")] },
      { ...link(3, "featured"), usages: [{ type: "featured" }, block("d", "file")] },
    ])
    expect(rows.map((r) => r.how)).toEqual(["Video block", "2 audio blocks", "Featured image and file block"])
  })

  it("labels each usage in order", () => {
    expect(usageLabels({ relationship_type: "featured", usages: [{ type: "featured" }, { type: "block", block_id: "x" }] })).toEqual([
      "featured image",
      "image block",
    ])
    // An API older than #176 sends no usages.
    expect(usageLabels({ relationship_type: "gallery" })).toEqual(["image in the post"])
    // #427
    expect(usageLabels({ relationship_type: "gallery", usages: [{ type: "block", block_id: "a", block_type: "cover" }, { type: "block", block_id: "b", block_type: "media_text" }] })).toEqual(["cover block", "media & text block"])
    expect(usageLabels({ relationship_type: "featured", usages: [] })).toEqual(["featured image"])
    // A captions file (#507) is used through the video blocks showing the video it captions.
    expect(usageLabels({ relationship_type: "captions", usages: [{ type: "captions", block_id: "v1", block_type: "video" }] })).toEqual(["captions of a video block"])
    expect(
      usageLabels({ relationship_type: "captions", usages: [{ type: "captions", block_id: "v1", block_type: "video" }, { type: "captions", block_id: "v2", block_type: "video" }] }),
    ).toEqual(["captions of 2 video blocks"])
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

describe("captions (#507)", () => {
  it("lets a video carry captions, from a WebVTT file", () => {
    expect(canHaveCaptions({ media_path: "/uploads/media/tour.mp4", mime_type: "video/mp4" })).toBe(true)
    expect(canHaveCaptions({ media_path: "/uploads/media/song.mp3", mime_type: "audio/mpeg" })).toBe(false)
    expect(canHaveCaptions({ media_path: "/uploads/media/a.jpg", mime_type: "image/jpeg" })).toBe(false)
    expect(isCaptionsFile({ mime_type: "text/vtt" })).toBe(true)
    expect(isCaptionsFile({ mime_type: "text/plain" })).toBe(false)
  })

  it("files a .vtt with the library's files, tagged VTT", () => {
    const vtt = { media_path: "/uploads/media/tour-en-0a1b.vtt", mime_type: "text/vtt" }
    expect(mediaKind(vtt)).toBe("file")
    expect(typeLabel(vtt)).toBe("VTT file")
  })
})

describe("focalObjectPosition", () => {
  it("matches the public ImageBlock's object-position", () => {
    expect(focalObjectPosition({ x: 0.29, y: 0.6 })).toBe("29% 60%")
    expect(focalObjectPosition({ x: 0.3333, y: 1 })).toBe("33.3% 100%")
    expect(focalObjectPosition(null)).toBe("50% 50%")
  })
})

describe("missing alt text (#325)", () => {
  const image = (over: Record<string, unknown> = {}) =>
    ({ media_path: "uploads/a.png", mime_type: "image/png", alt: "", decorative: false, ...over }) as Parameters<typeof missingAlt>[0]

  it("is an image, not decorative, whose alt is empty or only whitespace", () => {
    expect(missingAlt(image())).toBe(true)
    expect(missingAlt(image({ alt: " \t\n " }))).toBe(true)
    expect(missingAlt(image({ alt: undefined }))).toBe(true)
    expect(missingAlt(image({ media_path: "uploads/a.svg", mime_type: "image/svg+xml" }))).toBe(true)
    expect(missingAlt(image({ alt: "A red roof" }))).toBe(false)
    expect(missingAlt(image({ decorative: true }))).toBe(false)
    expect(missingAlt(image({ media_path: "uploads/a.pdf", mime_type: "application/pdf" }))).toBe(false)
    expect(missingAlt(image({ media_path: "uploads/a.mp4", mime_type: "video/mp4" }))).toBe(false)
    // The API decides by MIME type alone; an extension doesn't make it an image here
    // either, so a tagged tile is always in the filter.
    expect(missingAlt(image({ mime_type: "" }))).toBe(false)
  })

  it("read-only views say whether there's none on purpose", () => {
    expect(altTextValue({ alt: "A red roof" })).toBe("A red roof")
    expect(altTextValue({ alt: "  " })).toBe("None")
    expect(altTextValue({ alt: "A red roof", decorative: true })).toBe("None, decorative image")
  })

  it("the field's hint follows the decorative option", () => {
    expect(altHint(false)).toMatch(/^Describe what the image shows/)
    expect(altHint(true)).toBe("Not used while the image is marked decorative.")
  })
})

describe("the site design's uses (#496)", () => {
  const header: MediaSiteTemplateUse = {
    id: 5,
    theme: "default",
    kind: "part",
    slug: "header",
    title: "Header",
    published: true,
    working: true,
    usages: [{ type: "block", block_id: "a", block_type: "image" }],
  }
  const single: MediaSiteTemplateUse = {
    id: 8,
    theme: "default",
    kind: "template",
    slug: "single",
    title: "",
    published: false,
    working: true,
    usages: [
      { type: "block", block_id: "b", block_type: "cover" },
      { type: "block", block_id: "c", block_type: "image" },
    ],
  }

  it("names templates and parts as the Site editor does", () => {
    expect(siteTemplateName(header)).toBe("Header part")
    expect(siteTemplateName(single)).toBe("single template")
  })

  it("rows: the site logo first, then each template or part, saying what isn't live yet", () => {
    expect(siteDesignUsedInRows({ siteTemplates: [header, single], siteLogo: true })).toEqual([
      { key: "site-logo", title: "Site logo", how: "Settings › General", status: "" },
      { key: "site-template-5", title: "Header part", how: "Image block", status: "" },
      { key: "site-template-8", title: "single template", how: "Cover block and image block · Not published yet", status: "" },
    ])
    expect(siteDesignUsedInRows({ siteTemplates: [], siteLogo: false })).toEqual([])
    // A captions file is used through a video block.
    expect(siteDesignUsedInRows({ siteTemplates: [{ ...header, usages: [{ type: "captions", block_id: "v", block_type: "video" }] }], siteLogo: false })[0].how).toBe(
      "Captions of a video block"
    )
  })

  it("all rows: the site design first, then the posts (linked)", () => {
    const rows = allUsedInRows({ posts: [link(11, "featured")], siteTemplates: [header], siteLogo: false })
    expect(rows.map((r) => [r.title, r.postId])).toEqual([
      ["Header part", undefined],
      ["Post 11", 11],
    ])
  })

  it("names another theme's design as such", () => {
    const classic = { ...header, theme: "classic", theme_active: false }
    expect(siteTemplateName(classic)).toBe("Header part (classic theme)")
    expect(siteDesignUsedInRows({ siteTemplates: [classic], siteLogo: false })[0].how).toBe("Image block · Theme not active")
  })

  it("looks the files up a few at a time, gives up on a hung one and says it couldn't check", async () => {
    vi.useFakeTimers()
    try {
      const started: number[] = []
      const lookup = (id: number) => {
        started.push(id)
        if (id === 3) return new Promise<never>(() => {}) // hangs
        if (id === 4) return Promise.reject(new Error("500"))
        return new Promise<{ posts: never[]; siteTemplates: MediaSiteTemplateUse[]; siteLogo: boolean }>((resolve) =>
          setTimeout(() => resolve({ posts: [], siteTemplates: id === 1 ? [header] : [], siteLogo: id === 2 }), 10)
        )
      }
      const pending = lookUpSiteDesignNames([1, 2, 3, 4, 5, 6], lookup, { concurrency: 2, timeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(0)
      expect(started).toEqual([1, 2]) // two at a time
      await vi.advanceTimersByTimeAsync(2000)
      expect(started).toEqual([1, 2, 3, 4, 5, 6]) // the hung one was given up on
      expect(await pending).toEqual({ names: ["Header part", "Site logo"], failed: true })
    } finally {
      vi.useRealTimers()
    }
    expect(await lookUpSiteDesignNames([], () => Promise.reject(new Error("never")))).toEqual({ names: [], failed: false })
  })

  it("the delete confirmation names them", () => {
    expect(deleteSiteDesignNotice([], true)).toBe(SITE_DESIGN_CHECK_FAILED)
    expect(deleteSiteDesignNotice(["Site logo"], true)).toBe(
      "Also used in the site design: Site logo. It shows nothing in its place once it's deleted. Couldn't check the other files."
    )
    expect(siteDesignNames({ siteTemplates: [header, header, single], siteLogo: true })).toEqual(["Site logo", "Header part", "single template"])
    expect(deleteSiteDesignNotice([])).toBeNull()
    expect(deleteSiteDesignNotice(["Header part"])).toBe("Also used in the site design: Header part. It shows nothing in its place once it's deleted.")
    expect(deleteSiteDesignNotice(["Site logo", "Header part", "Footer part"])).toBe(
      "Also used in the site design: Site logo, Header part and Footer part. They show nothing in its place once it's deleted."
    )
  })
})