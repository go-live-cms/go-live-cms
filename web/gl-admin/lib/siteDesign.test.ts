import { describe, expect, it } from "vitest"
import type { SiteTemplate } from "./api/siteDesign"
import {
  checkNewName,
  codeLayoutOf,
  editorActions,
  groupsLabel,
  partRows,
  partSlugsIn,
  previewPathFor,
  previewPostTypeFor,
  problemText,
  publishButtonLabel,
  publishChanges,
  releaseSummary,
  releaseTime,
  resetConsequence,
  routeHasList,
  rowActions,
  rowPill,
  savedTemplateName,
  siteTemplateName,
  templateGroups,
  templatesUsingPart,
  usedInLabel,
  type OverviewInput,
} from "./siteDesign"

// The Site editor's rules (#493, docs/design/theme-builder.md 8, 9, 13.1).

function row(over: Partial<SiteTemplate> = {}): SiteTemplate {
  return {
    id: 1,
    theme_slug: "paper",
    kind: "template",
    slug: "single",
    title: "",
    block_revision: 2,
    working_state: "custom",
    source: "theme",
    source_hash: "h",
    published: true,
    doc_name: "template-1",
    created_at: "2026-11-01T10:00:00Z",
    changed_at: "2026-11-02T10:00:00Z",
    change: "",
    has_unpublished_changes: false,
    published_version_no: 3,
    default_changed: false,
    can_delete: false,
    ...over,
  }
}

const vocabulary = {
  postTypes: [{ name: "product", label: "Product" }],
  pageLayouts: [
    { name: "default", label: "Default" },
    { name: "fullwidth", label: "Full width" },
  ],
  taxonomies: [
    { name: "category", label: "Category" },
    { name: "post_tag", label: "Tag" },
  ],
}

describe("names of new templates and parts (13.1)", () => {
  it("drops accents, lower-cases, joins runs with one hyphen and trims", () => {
    expect(savedTemplateName("Landing")).toBe("landing")
    expect(savedTemplateName("  Café  Crème — Promo!! ")).toBe("cafe-creme-promo")
    expect(savedTemplateName("★★★")).toBe("")
    expect(savedTemplateName("a".repeat(70))).toBe("a".repeat(64))
    // Cut, then trimmed again: no hyphen left at the end.
    expect(savedTemplateName(`${"a".repeat(63)} b`)).toBe("a".repeat(63))
  })

  it("checks as it's typed: the slug, or why not", () => {
    const taken = new Set(["custom-landing"])
    expect(checkNewName("", "template", taken, "Paper")).toEqual({ ok: false, name: "", slug: null, error: null })
    expect(checkNewName("★★★", "template", taken, "Paper")).toMatchObject({ ok: false, error: "Use at least one letter or number." })
    expect(checkNewName("Landing", "template", taken, "Paper")).toMatchObject({ ok: false, error: "There’s already a page template called Landing in Paper." })
    expect(checkNewName("Spring launch landing page for the new pricing plans and the partner programme", "template", taken, "Paper")).toMatchObject({
      ok: false,
      error: "Use a shorter name: it can be up to 64 characters.",
    })
    expect(checkNewName("Docs", "template", taken, "Paper")).toEqual({ ok: true, name: "docs", slug: "custom-docs" })
    // A part's slug is its name.
    expect(checkNewName("Promo bar", "part", new Set(["header"]), "Paper")).toEqual({ ok: true, name: "promo-bar", slug: "promo-bar" })
    expect(checkNewName("Header", "part", new Set(["header"]), "Paper")).toMatchObject({ ok: false, error: "There’s already a part called Header in Paper." })
  })

  it("fits block:[a-z0-9-]{1,64} and the slug CHECK", () => {
    for (const typed of ["Ünïcödé!", "x", "Über 2026 — Ünd", "a b c"]) {
      const name = savedTemplateName(typed)
      expect(name).toMatch(/^[a-z0-9-]{1,64}$/)
      expect(`custom-${name}`).toMatch(/^[a-z0-9][a-z0-9_-]{0,79}$/)
    }
  })
})

describe("slugs", () => {
  it("names each route kind as the overview board does", () => {
    expect(siteTemplateName("template", "single", vocabulary)).toBe("Single post")
    expect(siteTemplateName("template", "single-product", vocabulary)).toBe("Single · Product")
    expect(siteTemplateName("template", "page-fullwidth", vocabulary)).toBe("Page · Full width")
    expect(siteTemplateName("template", "taxonomy-category", vocabulary)).toBe("Category")
    expect(siteTemplateName("template", "taxonomy-post_tag", vocabulary)).toBe("Tag")
    expect(siteTemplateName("template", "front-page")).toBe("Front page")
    expect(siteTemplateName("template", "custom-landing")).toBe("Landing")
    expect(siteTemplateName("template", "custom-landing", {}, "Landing page")).toBe("Landing page")
    expect(siteTemplateName("part", "promo_bar")).toBe("Promo bar")
  })

  it("knows the code layout that renders an uncustomized one", () => {
    expect(codeLayoutOf("single")).toBe("post/default")
    expect(codeLayoutOf("page-fullwidth")).toBe("page/fullwidth")
    expect(codeLayoutOf("taxonomy-tag")).toBe("term/default")
    expect(codeLayoutOf("404")).toBe("error/default")
    expect(codeLayoutOf("front-page")).toBeNull()
  })

  it("offers “This page's list” only where the route has one (13.1)", () => {
    for (const slug of ["home", "front-page", "archive", "archive-product", "taxonomy-category", "author", "search"]) expect(routeHasList("template", slug)).toBe(true)
    for (const slug of ["single", "single-product", "page", "custom-landing", "404"]) expect(routeHasList("template", slug)).toBe(false)
    expect(routeHasList("part", "header")).toBe(false)
  })
})

describe("the overview (13.1 “Overview vocabulary”)", () => {
  const input = (templates: SiteTemplate[], over: Partial<OverviewInput> = {}): OverviewInput => ({
    themeName: "Paper",
    overview: { templates },
    shippedTemplates: { "404": {} },
    shippedParts: {},
    vocabulary,
    ...over,
  })

  it("lists every route kind in the board's groups, saying what renders each", () => {
    const groups = templateGroups(input([]))
    expect(groups.map((g) => g.label)).toEqual(["Home and front page", "Posts", "Pages", "Archives", "Search and errors"])
    const bySlug = Object.fromEntries(groups.flatMap((g) => g.rows).map((r) => [r.slug, r]))
    expect(bySlug["front-page"].source).toBe("Not customized · Home renders /")
    expect(bySlug.home.source).toBe("Theme layout · home/default")
    expect(bySlug.single.source).toBe("Theme layout · post/default")
    expect(bySlug["page-fullwidth"].source).toBe("Theme layout · page/fullwidth")
    expect(bySlug["taxonomy-category"].source).toBe("Theme layout · term/default")
    expect(bySlug["404"].source).toBe("Theme template · 404")
    expect(bySlug.single.action).toBe("Customize")
    expect(bySlug.single.customizeFrom).toBe("starter")
    expect(bySlug["404"].customizeFrom).toBe("theme")
    expect(groups.find((g) => g.id === "pages")!.rows.map((r) => r.slug)).toEqual(["page", "page-fullwidth"])
  })

  it("says how a customized row stands", () => {
    const changed = row({ slug: "single", change: "publish", has_unpublished_changes: true })
    const live = row({ id: 2, slug: "archive" })
    const landing = row({ id: 3, slug: "custom-landing", title: "Landing", published: false, published_version_no: null, change: "publish", has_unpublished_changes: true, can_delete: true })
    const search = row({ id: 4, slug: "search", default_changed: true })
    const reset = row({ id: 5, slug: "author", working_state: "reset", change: "reset", has_unpublished_changes: true })
    const rows = Object.fromEntries(templateGroups(input([changed, live, landing, search, reset])).flatMap((g) => g.rows).map((r) => [r.slug, r]))
    expect(rows.single.pill).toEqual({ label: "Customized · changes not published", tone: "accent" })
    expect(rows.single.meta).toBe("Replaces Paper’s post layouts, so a post type’s layout choice no longer applies to posts.")
    expect(rows.archive.pill).toEqual({ label: "Customized", tone: "success" })
    expect(rows.archive.meta).toBe("Category and tag pages still use Paper’s term layout. Customize Category to change them.")
    expect(rows["custom-landing"]).toMatchObject({ name: "Landing", tag: "Page template", action: "Edit" })
    expect(rows.search.pill).toEqual({ label: "Default changed since you customized", tone: "warning" })
    expect(rows.author.pill).toEqual({ label: "Resets on publish", tone: "warning" })
    expect(rows.author.source).toBe("Theme layout · author/default")
  })

  it("a type's single template falls back to a published Single post", () => {
    const rows = Object.fromEntries(templateGroups(input([row({ slug: "single" })])).flatMap((g) => g.rows).map((r) => [r.slug, r]))
    expect(rows["single-product"].source).toBe("Uses Single post")
  })

  it("lists the starter parts, the theme's and any customized one", () => {
    const parts = partRows(input([row({ id: 9, kind: "part", slug: "promo", title: "Promo" })], { shippedParts: { sidebar: {} } }))
    expect(parts.map((p) => p.slug)).toEqual(["header", "footer", "sidebar", "promo"])
    expect(parts[0].source).toBe("Theme layout · Paper’s header")
    expect(parts[2].source).toBe("Theme part · Paper’s sidebar")
    expect(parts[2].customizeFrom).toBe("theme")
    expect(parts[3]).toMatchObject({ name: "Promo", action: "Edit" })
  })

  it("rowPill: a reset whose reset is published renders the theme's", () => {
    expect(rowPill(row({ working_state: "reset", published: false, change: "" }))).toBeNull()
  })
})

describe("menus", () => {
  it("a customized item's row menu (the board's)", () => {
    const actions = rowActions(row({ has_unpublished_changes: true }))
    expect(actions.map((a) => a.id)).toEqual(["edit", "preview", "history", "discard", "reset", "delete"])
    expect(actions.find((a) => a.id === "delete")).toMatchObject({ disabled: true, hint: "Published once. Reset it instead." })
  })

  it("a custom template never published: History off, Delete on", () => {
    const actions = rowActions(row({ published: false, published_version_no: null, can_delete: true, has_unpublished_changes: true }))
    expect(actions.map((a) => a.id)).toEqual(["edit", "preview", "history", "delete"])
    expect(actions.find((a) => a.id === "history")).toMatchObject({ disabled: true })
    expect(actions.find((a) => a.id === "delete")).toMatchObject({ danger: true })
  })

  it("a reset waiting for publish offers Keep editing", () => {
    expect(rowActions(row({ working_state: "reset", change: "reset" })).map((a) => a.id)).toContain("keep-editing")
    expect(editorActions(row({ working_state: "reset" })).map((a) => a.id)).toEqual(["history", "keep-editing"])
  })

  it("the editor's More menu", () => {
    expect(editorActions(row({ has_unpublished_changes: true })).map((a) => a.id)).toEqual(["history", "discard", "start-over", "reset"])
    expect(rowActions(null).map((a) => a.id)).toEqual(["preview"])
  })

  it("Reset says what renders after the publish (section 9)", () => {
    expect(resetConsequence("template", "single", "Single post", "Paper", false)).toBe(
      "Single post will use Paper’s code layout again when you publish. Your version stays in History, so you can restore it."
    )
    expect(resetConsequence("part", "header", "Header", "Paper", true)).toContain("Paper’s part")
  })
})

describe("publish (8.2, 13.1)", () => {
  const overview = {
    templates: [
      row({ id: 1, slug: "single", change: "publish" }),
      row({ id: 2, kind: "part", slug: "header", change: "publish" }),
      row({ id: 3, slug: "author", change: "reset" }),
      row({ id: 4, slug: "custom-pricing", title: "Pricing", change: "publish", published_version_no: null }),
      row({ id: 5, slug: "archive", change: "" }),
    ],
    global_styles_changed: true,
    global_styles_groups: ["colors", "fonts"],
  }

  it("lists every change: templates, parts, then the styles", () => {
    expect(publishChanges(overview, vocabulary).map((c) => [c.name, c.what])).toEqual([
      ["Author", "Template · resets to the theme default"],
      ["Pricing", "Template · new"],
      ["Single post", "Template · changed"],
      ["Header", "Template part · changed"],
      ["Global styles", "Colours, Fonts"],
    ])
  })

  it("names each refusal with what to open", () => {
    const templates = overview.templates
    expect(problemText({ code: "template_empty", id: 1, kind: "template", slug: "single" }, templates, vocabulary)).toMatchObject({
      title: "Single post is empty",
      openId: 1,
      openLabel: "Open Single post",
    })
    expect(problemText({ code: "part_unresolved", id: 4, kind: "template", slug: "custom-pricing", part: "promo" }, templates)).toMatchObject({
      title: "Pricing uses a part that doesn’t exist",
      body: expect.stringContaining("“promo”"),
    })
    expect(problemText({ code: "template_invalid", id: 2, kind: "part", slug: "header", reason: "a block this build doesn't have" }, templates).body).toBe(
      "a block this build doesn't have."
    )
  })

  it("labels", () => {
    expect(publishButtonLabel(3)).toBe("Publish site design, 3 changes")
    expect(publishButtonLabel(1)).toBe("Publish site design, 1 change")
    expect(groupsLabel([])).toBe("Changed")
    expect(groupsLabel(["layout", "radius"])).toBe("Layout, Radius")
  })
})

describe("preview (8.3)", () => {
  it("a list route's own address, or a post to pick", () => {
    expect(previewPathFor("template", "home")).toBe("/")
    expect(previewPathFor("template", "search")).toBe("/search?q=the")
    expect(previewPathFor("template", "taxonomy-category", { taxonomy: "category", slug: "guides" })).toBe("/category/guides")
    expect(previewPathFor("template", "single")).toBeNull()
    expect(previewPostTypeFor("template", "single")).toBe("post")
    expect(previewPostTypeFor("template", "single-product")).toBe("product")
    expect(previewPostTypeFor("template", "custom-landing")).toBe("page")
    expect(previewPostTypeFor("part", "header")).toBeNull()
  })
})

describe("parts in templates", () => {
  const doc = (slugs: string[]) => ({
    blocks: Object.fromEntries(slugs.map((slug, i) => [`b${i}`, { type: "template_part", attrs: { slug } }])),
  })

  it("“Used in N templates”", () => {
    expect(partSlugsIn(doc(["header", "footer", "header"]))).toEqual(["header", "footer"])
    expect(templatesUsingPart("header", [
      { name: "Single post", doc: doc(["header", "footer"]) },
      { name: "Archive", doc: doc(["header"]) },
      { name: "404", doc: doc(["footer"]) },
      { name: "Broken", doc: null },
    ])).toEqual(["Archive", "Single post"])
    expect(usedInLabel(0)).toBe("Not used in any template")
    expect(usedInLabel(1)).toBe("Used in 1 template")
    expect(usedInLabel(7)).toBe("Used in 7 templates")
  })
})

describe("history", () => {
  it("a release's line and time", () => {
    expect(releaseSummary([{ kind: "part", slug: "header", title: "Header" }, { kind: "template", slug: "single", title: "" }], ["colors"])).toBe("Header, Single post, Colours")
    expect(releaseSummary([], null)).toBe("Nothing listed")
    const now = new Date("2026-11-17T12:00:00")
    expect(releaseTime("2026-11-14T10:02:00", now)).toBe("Nov 14, 10:02")
    expect(releaseTime("2025-11-14T10:02:00", now)).toBe("Nov 14, 2025, 10:02")
    expect(releaseTime("nope", now)).toBe("")
  })
})
