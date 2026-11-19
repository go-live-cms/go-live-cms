import { describe, expect, it } from "vitest"
import type { ImportItem, ImportJob, ImportSummary } from "./api/imports"
import {
  authorMeta,
  defaultMapping,
  droppedTitle,
  droppedWhere,
  exportTypeLabel,
  failedMedia,
  importCount,
  importNoticeBody,
  importNoticeTitle,
  itemMeta,
  listPhrase,
  noteTexts,
  originalText,
  previewSentence,
  progressDetail,
  progressLine,
  progressPercent,
  reasonText,
  recentMeta,
  reportSummary,
  reportTabs,
  skippedSentence,
  tabQuery,
  typeChoices,
} from "./imports"

// The Import page's rules (#150): lib/imports.ts.

const summary: ImportSummary = {
  source: "wxr",
  site_url: "https://example.com",
  site_host: "example.com",
  items: 69,
  authors: [
    { login: "ana", display_name: "Ana Costa", posts: 31, suggested_user_id: 7, matched_by: "email" },
    { login: "kenji", display_name: "Kenji Sato", posts: 17, suggested_user_id: 0 },
  ],
  types: [
    { type: "post", count: 45, published: 40, suggested: "post" },
    { type: "page", count: 6, published: 6, suggested: "page" },
    { type: "product", count: 18, published: 18, suggested: "" },
  ],
  categories: 9,
  tags: 31,
  other_terms: 2,
  attachments: 57,
  files: 0,
  skipped: { in_trash: 3 },
  not_imported: { comments: 120, nav_menu_item: 4 },
}

const progress = { total: 48, pending: 30, imported: 16, skipped: 2, failed: 0, with_dropped: 1 }
const job = { progress } as Pick<ImportJob, "progress">

const labels = { post: "Posts", page: "Pages", "": "Don’t import" }

describe("the mapping step", () => {
  it("starts from the suggestions", () => {
    expect(defaultMapping(summary)).toEqual({ authors: { ana: 7, kenji: 0 }, types: { post: "post", page: "page", product: "" } })
  })

  it("describes authors and types", () => {
    expect(authorMeta(summary.authors[0])).toBe("ana · 31 posts · same email as a member")
    expect(authorMeta({ ...summary.authors[1], posts: 1 })).toBe("kenji · 1 post")
    expect(exportTypeLabel("post")).toBe("Posts")
    expect(exportTypeLabel("product")).toBe("Products (product)")
    expect(exportTypeLabel("case_study")).toBe("Case studies (case_study)")
    expect(typeChoices([{ name: "post", label: "Posts" }])).toEqual([
      { value: "post", label: "Posts" },
      { value: "", label: "Don’t import" },
    ])
  })

  it("says what will be imported, following the choices", () => {
    const mapping = defaultMapping(summary)
    expect(previewSentence(summary, mapping, labels)).toBe("45 posts, 6 pages, 9 categories and 31 tags and the images they use from example.com.")
    expect(importCount(summary, mapping)).toBe(51)
    // Products into posts too.
    const all = { ...mapping, types: { ...mapping.types, product: "post" } }
    expect(previewSentence(summary, all, labels)).toBe("63 posts, 6 pages, 9 categories and 31 tags and the images they use from example.com.")
    const none = { ...mapping, types: { post: "", page: "", product: "" } }
    expect(importCount(summary, none)).toBe(0)
    expect(previewSentence({ ...summary, categories: 0, tags: 0 }, none, labels)).toBe("Nothing: choose at least one content type to import.")
    expect(previewSentence({ ...summary, source: "markdown", files: 3, site_host: undefined }, mapping, labels)).toContain("the images in the zip they use")
  })

  it("says what is skipped and not imported", () => {
    expect(skippedSentence(summary, defaultMapping(summary), 3)).toBe(
      "3 items were imported before and will be skipped. Not imported: 18 products, 3 items in the trash, 120 comments, 4 menu items and 2 terms of other taxonomies.",
    )
    expect(skippedSentence({ ...summary, types: [], skipped: {}, not_imported: {}, other_terms: 0 }, { authors: {}, types: {} }, 0)).toBeNull()
    expect(listPhrase(["a"])).toBe("a")
    expect(listPhrase(["a", "b"])).toBe("a and b")
  })
})

describe("progress and the report", () => {
  it("counts progress", () => {
    expect(progressLine(job)).toBe("18 of 48 items")
    expect(progressDetail(job)).toBe("16 imported · 2 skipped")
    expect(progressPercent(job)).toBe(38)
    expect(progressPercent({ progress: { ...progress, total: 0, pending: 0 } })).toBe(100)
  })

  it("sums the report up", () => {
    expect(reportSummary({ progress: { total: 48, pending: 0, imported: 44, skipped: 3, failed: 1, with_dropped: 2 } }, 2)).toBe(
      "44 imported · 3 skipped · 1 failed · 2 with dropped blocks · 2 images failed",
    )
    expect(reportSummary(job)).toBe("16 imported · 2 skipped · 30 not imported · 1 with dropped blocks")
  })

  it("lists only the tabs with rows", () => {
    expect(reportTabs(job).map((t) => t.id)).toEqual(["all", "imported", "dropped", "skipped"])
    expect(tabQuery("dropped")).toEqual({ dropped: true })
    expect(tabQuery("failed")).toEqual({ status: "failed" })
    expect(tabQuery("all")).toEqual({})
  })

  it("describes recent imports", () => {
    const now = new Date("2026-11-19T12:00:00Z")
    const base = { id: 1, source: "wxr" as const, file_name: "x.xml", site_url: "", summary, created_at: "2026-11-18T10:00:00Z", finished_at: null }
    expect(recentMeta({ ...base, status: "mapping", progress }, now)).toBe("Nov 18 · waiting for the mapping")
    expect(recentMeta({ ...base, status: "running", progress }, now)).toBe("Nov 18 · 18 of 48 items")
    expect(recentMeta({ ...base, status: "cancelled", progress }, now)).toBe("Nov 18 · 18 of 48 when stopped")
    expect(recentMeta({ ...base, status: "done", progress: { ...progress, pending: 0 } }, now)).toBe("Nov 18 · 16 imported · 2 skipped · 1 with dropped blocks")
    expect(recentMeta({ ...base, created_at: "2025-03-01T10:00:00Z", status: "mapping", progress }, now)).toBe("Mar 1, 2025 · waiting for the mapping")
  })

  const item = (over: Partial<ImportItem>): ImportItem => ({
    id: 1,
    position: 1,
    type: "post",
    title: "Hello",
    status: "imported",
    post_id: 5,
    post_type: "post",
    post_status: "published",
    result: {},
    processed_at: null,
    ...over,
  })

  it("describes rows", () => {
    expect(itemMeta(item({}))).toBe("Post · Published")
    expect(itemMeta(item({ post_status: "draft", post_type: "page" }))).toBe("Page · Draft")
    expect(itemMeta(item({ post_status: undefined }))).toBe("Post · Deleted since")
    expect(itemMeta(item({ status: "skipped", post_type: undefined, type: "product" }))).toBe("product · Skipped")
    expect(reasonText(item({ status: "skipped", reason: "imported_before" }))).toBe("Imported before")
    expect(reasonText(item({ status: "failed", reason: "invalid_body", result: { error: "Too many blocks" } }))).toBe("The body couldn’t be stored: Too many blocks")
    expect(reasonText(item({ status: "failed", reason: "odd" }))).toBe("Not imported")
  })

  it("lists an item's notes", () => {
    expect(
      noteTexts(item({ result: { notes: ["extra_categories", "was_private", "unknown_note"], publish_refused: "Needs a summary", slug: "hello-2", redirects: ["/2024/05/hello"] } })),
    ).toEqual([
      "A post has one category here: the first one was kept",
      "Private in WordPress: imported as a draft",
      "unknown_note",
      "Imported as a draft: Needs a summary",
      "Its address was taken, so it is /hello-2",
      "The old address redirects here: /2024/05/hello",
    ])
  })

  it("words dropped blocks and failed images", () => {
    expect(droppedTitle(1)).toBe("1 block couldn’t be kept")
    expect(droppedTitle(2)).toBe("2 blocks couldn’t be kept")
    expect(droppedWhere("Get in touch")).toBe("after “Get in touch”")
    expect(droppedWhere(undefined)).toBe("at the start")
    expect(originalText([{ label: "a", original: "[form]" }, { label: "b", original: "<script>x</script>" }])).toBe("[form]\n\n<script>x</script>")
    const failure = { url: "example.com/a.jpg", code: "status", reason: "The server answered 404" }
    expect(failedMedia([item({ result: { media_failed: [failure] } }), item({ title: "" , result: { media_failed: [failure] } })])).toEqual([
      { ...failure, post: "Hello" },
      { ...failure, post: "Untitled" },
    ])
    const notice = { dropped: [{ label: "Latest posts block", original: "x", after: "Intro" }], media_failed: [failure] }
    expect(importNoticeTitle(notice)).toBe("1 block couldn’t be kept, and 1 image couldn’t be added in the import")
    expect(importNoticeTitle({ dropped: [], media_failed: [failure, failure] })).toBe("2 images couldn’t be added in the import")
    expect(importNoticeBody(notice)).toEqual(["Latest posts block — after “Intro”", "example.com/a.jpg: The server answered 404"])
  })
})
