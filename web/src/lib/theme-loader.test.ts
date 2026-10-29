import { beforeEach, describe, expect, it, vi } from "vitest"

const getActiveTheme = vi.fn()
vi.mock("./api", () => ({ getActiveTheme: () => getActiveTheme() }))

const { getPostLayoutVariant } = await import("./theme-loader")

// The Themes screen saves one layout per post type in the active theme's settings
// (layout_variants); the post route picks the layout file from it (#345).
describe("getPostLayoutVariant", () => {
  beforeEach(() => {
    getActiveTheme.mockReset()
  })

  it("maps each post type to the variant saved for it", async () => {
    getActiveTheme.mockResolvedValue({ slug: "default", settings: { layout_variants: { post: "sidebar", page: "fullwidth" } } })
    expect(await getPostLayoutVariant({}, "post")).toBe("sidebar")
    expect(await getPostLayoutVariant({}, "page")).toBe("fullwidth")
  })

  it("uses default for a type with no saved variant", async () => {
    getActiveTheme.mockResolvedValue({ slug: "default", settings: { layout_variants: { post: "wide" } } })
    expect(await getPostLayoutVariant({}, "page")).toBe("default")
    expect(await getPostLayoutVariant({}, "recipe")).toBe("default")
  })

  it("uses default without settings, or when the API fails", async () => {
    getActiveTheme.mockResolvedValue({ slug: "default", settings: {} })
    expect(await getPostLayoutVariant({}, "post")).toBe("default")
    getActiveTheme.mockResolvedValue({ slug: "default" })
    expect(await getPostLayoutVariant({}, "post")).toBe("default")
    getActiveTheme.mockImplementation(async () => {
      throw new Error("down")
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await getPostLayoutVariant({}, "post")).toBe("default")
  })
})
