import { describe, expect, it, vi } from "vitest"
import type { PublicPost } from "./api"
import { resolveCategoryRoute } from "./categoryUrls"

const published = (post: Record<string, unknown>): PublicPost =>
  ({ post: { id: 7, slug: "hello", post_type: "post", post_status: "published", category_slug: "guides", ...post }, featured_image: null, taxonomy_terms: [] }) as unknown as PublicPost

describe("resolveCategoryRoute (#331)", () => {
  it("renders the post at its category's URL", async () => {
    const getPost = vi.fn(async () => published({}))
    const route = await resolveCategoryRoute("guides", "hello", "category", getPost)
    expect(getPost).toHaveBeenCalledWith("hello")
    expect(route.kind).toBe("post")
  })

  it("sends any other /x/{slug} to the post's URL (a renamed or changed category, another structure)", async () => {
    const getPost = async () => published({})
    expect(await resolveCategoryRoute("old-guides", "hello", "category", getPost)).toEqual({ kind: "redirect", location: "/guides/hello" })
    expect(await resolveCategoryRoute("guides", "hello", "slug", getPost)).toEqual({ kind: "redirect", location: "/post/hello" })
    expect(await resolveCategoryRoute("guides", "hello", "id", getPost)).toEqual({ kind: "redirect", location: "/post/7" })
  })

  it("leaves everything else to the route", async () => {
    // Not a post slug: no API call at all.
    const never = vi.fn()
    expect(await resolveCategoryRoute("wp", "login.php", "category", never)).toEqual({ kind: "none" })
    expect(await resolveCategoryRoute("x", "a_b", "category", never)).toEqual({ kind: "none" })
    expect(never).not.toHaveBeenCalled()
    expect((await resolveCategoryRoute("old", "olá", "category", async () => published({ slug: "olá" }))).kind).toBe("redirect")
    expect(await resolveCategoryRoute("guides", "42", "category", vi.fn())).toEqual({ kind: "none" })
    expect(await resolveCategoryRoute("guides", "nope", "category", async () => null)).toEqual({ kind: "none" })
    expect(await resolveCategoryRoute("guides", "about", "category", async () => published({ slug: "about", post_type: "page" }))).toEqual({ kind: "none" })
    // The type's own URL is the route's ordinary case, not a loop.
    expect(await resolveCategoryRoute("post", "hello", "slug", async () => published({}))).toEqual({ kind: "none" })
    // A post without a category stays at /post/slug under the category structure.
    expect(await resolveCategoryRoute("post", "hello", "category", async () => published({ category_slug: undefined }))).toEqual({ kind: "none" })
  })
})
