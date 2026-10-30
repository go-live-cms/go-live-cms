import { describe, expect, it, vi } from "vitest"
import { footerColumns, getMenu, normalizeMenu, safeMenuHref, withCurrent, type MenuLink } from "./menus"

const link = (id: number, url: string, children: MenuLink[] = []): MenuLink => ({ id, label: `L${id}`, url, children })

describe("safeMenuHref", () => {
  it("keeps http(s) and site-relative URLs only", () => {
    for (const ok of ["/", "/page/about?x=1#top", "https://example.com", "http://example.com/a"]) expect(safeMenuHref(ok)).toBe(ok)
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "about", "/a b", "", null, 3]) {
      expect(safeMenuHref(bad)).toBeNull()
    }
  })
})

describe("normalizeMenu (menu tree building)", () => {
  it("keeps labelled links with safe URLs, one level deep", () => {
    const menu = normalizeMenu({
      name: "Main",
      location: "primary",
      items: [
        { id: 1, label: " Guides ", url: "/category/guides", children: [
          { id: 2, label: "Setup", url: "/page/setup", children: [{ id: 9, label: "Too deep", url: "/x" }] },
          { id: 3, label: "Bad", url: "javascript:alert(1)" },
        ] },
        { id: 4, label: "", url: "/no-label" },
        "junk",
        { id: 5, label: "About", url: "/page/about" },
      ],
    })
    expect(menu).toEqual({
      name: "Main",
      location: "primary",
      items: [
        { id: 1, label: "Guides", url: "/category/guides", children: [{ id: 2, label: "Setup", url: "/page/setup", children: [] }] },
        { id: 5, label: "About", url: "/page/about", children: [] },
      ],
    })
  })

  it("is null when nothing is left to show", () => {
    expect(normalizeMenu({ items: [] })).toBeNull()
    expect(normalizeMenu({ items: [{ label: "x", url: "javascript:x" }] })).toBeNull()
    expect(normalizeMenu(null)).toBeNull()
  })
})

describe("withCurrent", () => {
  it("marks site-relative links to the current path, ignoring query, hash and trailing slash", () => {
    const items = [link(1, "/page/about/"), link(2, "/category/guides", [link(3, "/post/hello?ref=menu#top")]), link(4, "https://example.com/post/hello")]
    const marked = withCurrent(items, "/post/hello")
    expect(marked.map((l) => l.current)).toEqual([false, false, false])
    expect(marked[1].children[0].current).toBe(true)
    expect(withCurrent(items, "/page/about")[0].current).toBe(true)
  })
})

describe("footerColumns", () => {
  it("gives each parent a column and gathers the rest where the first of them was", () => {
    const columns = footerColumns([link(1, "/a"), link(2, "/legal", [link(3, "/privacy")]), link(4, "/b")])
    expect(columns).toEqual([
      { heading: null, links: [link(1, "/a"), link(4, "/b")] },
      { heading: link(2, "/legal", [link(3, "/privacy")]), links: [link(3, "/privacy")] },
    ])
    expect(footerColumns([])).toEqual([])
  })
})

describe("getMenu", () => {
  it("fetches the location's menu, null when none is assigned or the API fails", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ name: "Main", location: "primary", items: [{ id: 1, label: "A", url: "/a" }] })))
    expect((await getMenu("primary", ok as unknown as typeof fetch))?.items[0].url).toBe("/a")
    expect(String((ok.mock.calls[0] as unknown[])[0])).toMatch(/\/public\/menus\/primary$/)

    const missing = vi.fn(async () => new Response("{}", { status: 404 }))
    expect(await getMenu("footer", missing as unknown as typeof fetch)).toBeNull()

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const broken = vi.fn(async () => new Response("{}", { status: 500 }))
    expect(await getMenu("footer", broken as unknown as typeof fetch)).toBeNull()
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await getMenu("footer", down as unknown as typeof fetch)).toBeNull()
    // A request that never settles (a hung lookup) gives up on time.
    const hung = vi.fn(() => new Promise<Response>(() => {}))
    expect(await getMenu("footer", hung as unknown as typeof fetch, 20)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })
})
