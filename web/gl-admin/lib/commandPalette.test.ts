import { describe, expect, it } from "vitest"
import type { CommandPaletteResults } from "./api/commandPalette"
import type { Media } from "./api/types"
import { flattenPaletteSections, isCommandPaletteShortcut, isEditorFocused, paletteActions, paletteSections } from "./commandPalette"

const labels = (role: string | undefined) => paletteActions(role).map((a) => a.label)

const media = (over: Partial<Media> = {}) => ({ id: 3, name: "chart.png", media_path: "/uploads/media/chart.png", mime_type: "image/png", ...over }) as Media

const results = (over: Partial<CommandPaletteResults> = {}): CommandPaletteResults => ({ posts: [], pages: [], media: [], terms: [], ...over })

describe("paletteActions", () => {
  it("gives admins every action", () => {
    expect(labels("admin")).toEqual(["New post", "New page", "Settings", "Media", "Users"])
  })

  it("hides Settings and Users from the roles that can't use them", () => {
    expect(labels("editor")).toEqual(["New post", "New page", "Media"])
    expect(labels("contributor")).toEqual(["New post", "New page", "Media"])
  })

  it("offers nothing to a role without content access", () => {
    expect(labels("subscriber")).toEqual([])
    expect(labels(undefined)).toEqual([])
  })

  it("matches roles without regard to case", () => {
    expect(labels("ADMIN")).toEqual(["New post", "New page", "Settings", "Media", "Users"])
  })

  it("links each action to its page", () => {
    expect(paletteActions("admin").map((a) => a.to)).toEqual(["/content/post/new", "/content/page/new", "/settings", "/media", "/users"])
  })
})

describe("paletteSections", () => {
  const actions = paletteActions("admin")

  it("shows only the actions with nothing typed", () => {
    const sections = paletteSections({ query: "  ", actions, results: null })
    expect(sections.map((s) => s.label)).toEqual(["Jump to"])
    expect(flattenPaletteSections(sections)).toHaveLength(5)
  })

  it("orders the groups and leaves empty ones out", () => {
    const sections = paletteSections({
      query: "new",
      actions,
      results: results({
        posts: [{ id: 1, title: "News", post_type: "post", post_status: "draft" }],
        terms: [{ id: 4, name: "Newsroom", slug: "newsroom", taxonomy_type: "category", taxonomy_label: "Categories" }],
      }),
    })
    expect(sections.map((s) => s.label)).toEqual(["Jump to", "Posts", "Terms"])
  })

  it("matches actions at the start of a word and marks the match", () => {
    const [jump] = paletteSections({ query: "pa", actions, results: null })
    expect(jump.options.map((o) => o.label)).toEqual(["New page"])
    expect(jump.options[0].match).toEqual([4, 6])
    expect(paletteSections({ query: "ost", actions, results: null })).toEqual([])
  })

  it("builds each kind's row and where it opens", () => {
    const options = flattenPaletteSections(
      paletteSections({
        query: "an",
        actions: [],
        results: results({
          posts: [{ id: 1, title: "Analytics", post_type: "post", post_status: "published" }],
          pages: [{ id: 2, title: "", post_type: "page", post_status: "draft" }],
          media: [media({ id: 3, name: "plan.mp4", media_path: "/uploads/media/plan.mp4", mime_type: "video/mp4" })],
          terms: [{ id: 4, name: "Plans", slug: "plans", taxonomy_type: "page_category", taxonomy_label: "Categories" }],
          users: [{ id: 5, username: "ana", full_name: "Ana Costa", avatar: null, role: "editor" }],
        }),
      })
    )
    expect(options.map(({ key, label, to, meta }) => ({ key, label, to, meta }))).toEqual([
      { key: "post-1", label: "Analytics", to: "/content/edit/1", meta: "Published" },
      { key: "page-2", label: "Untitled", to: "/content/edit/2", meta: "Draft" },
      { key: "media-3", label: "plan.mp4", to: "/media/3", meta: "Video" },
      { key: "term-4", label: "Plans", to: "/taxonomies?type=page_category&term=4", meta: "Category" },
      { key: "user-5", label: "Ana Costa", to: "/users/edit/5", meta: "Editor" },
    ])
    expect(options[0].match).toEqual([0, 2])
    expect(options[1].match).toBeUndefined()
  })
})

describe("the shortcut", () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: "k", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })

  it("is Ctrl or Cmd K, and nothing else", () => {
    expect(isCommandPaletteShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isCommandPaletteShortcut(key({ metaKey: true, key: "K" }))).toBe(true)
    expect(isCommandPaletteShortcut(key({}))).toBe(false)
    expect(isCommandPaletteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isCommandPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(isCommandPaletteShortcut(key({ ctrlKey: true, key: "j" }))).toBe(false)
  })

  it("knows when focus is in the editor, a field inside a block included", () => {
    const editor = document.createElement("div")
    editor.className = "tiptap ProseMirror"
    const caption = document.createElement("input")
    editor.appendChild(caption)
    expect(isEditorFocused(editor)).toBe(true)
    expect(isEditorFocused(caption)).toBe(true)
    expect(isEditorFocused(document.createElement("input"))).toBe(false)
    expect(isEditorFocused(null)).toBe(false)
  })
})
