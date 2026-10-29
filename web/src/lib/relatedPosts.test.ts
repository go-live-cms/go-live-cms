import { describe, expect, it, vi } from "vitest"
import type { Post, TaxonomyTerm } from "@gl-admin/lib/api/types"
import { loadPostEnd, primaryCategory, RELATED_POSTS_LIMIT, type PostEndSource } from "./relatedPosts"
import type { ListedPost } from "./postList"

const row = (id: number, extra: Partial<Post> = {}) => ({ id, title: `Post ${id}`, slug: `post-${id}`, post_type: "post", ...extra }) as Post
const term = (id: number, type: string, name = `T${id}`) => ({ id, name, slug: `t-${id}`, taxonomy_type_name: type }) as TaxonomyTerm

function source(overrides: Partial<PostEndSource> = {}): PostEndSource {
  return {
    getAdjacentPosts: vi.fn(async () => ({ previous: row(1), next: row(3) })),
    getRelatedPosts: vi.fn(async (_id, params) => (params?.termId ? [row(7)] : [row(5), row(6)])),
    getUrlStructure: async () => "slug",
    toListedPost: vi.fn(async (post: Post, postType: string, structure: string) => ({ post, href: `/${post.post_type || postType}/${structure === "slug" ? post.slug : post.id}`, image: null }) as ListedPost),
    ...overrides,
  }
}

describe("primaryCategory", () => {
  it("is the first category term", () => {
    expect(primaryCategory([term(1, "tag"), term(2, "category"), term(3, "category")])?.id).toBe(2)
    expect(primaryCategory([term(1, "tag")])).toBeUndefined()
    expect(primaryCategory(undefined)).toBeUndefined()
  })
})

describe("loadPostEnd", () => {
  const post = { id: 2, post_type: "post" }

  it("loads older/newer and related posts with links in the site's URL structure", async () => {
    const src = source()
    const end = await loadPostEnd(post, [], "https://example.com", {}, src)
    expect(end.previous?.href).toBe("/post/post-1")
    expect(end.next?.href).toBe("/post/post-3")
    expect(end.related.map((r) => r.post.id)).toEqual([5, 6])
    expect(end.inCategory).toBeNull()
    expect(src.getRelatedPosts).toHaveBeenCalledTimes(1)
    expect(src.getRelatedPosts).toHaveBeenCalledWith(2, { limit: RELATED_POSTS_LIMIT })
  })

  it("loads the category's posts only when asked and the post has a category", async () => {
    const cat = term(9, "category", "Product updates")
    const src = source()
    const end = await loadPostEnd(post, [term(1, "tag"), cat], "https://example.com", { inCategory: true }, src)
    expect(src.getRelatedPosts).toHaveBeenCalledWith(2, { limit: RELATED_POSTS_LIMIT, termId: 9 })
    expect(end.inCategory?.term).toBe(cat)
    expect(end.inCategory?.posts.map((r) => r.post.id)).toEqual([7])

    const noCategory = source()
    expect((await loadPostEnd(post, [term(1, "tag")], "https://example.com", { inCategory: true }, noCategory)).inCategory).toBeNull()
    expect(noCategory.getRelatedPosts).toHaveBeenCalledTimes(1)
  })

  it("leaves out a category with no other posts", async () => {
    const src = source({ getRelatedPosts: vi.fn(async (_id, params) => (params?.termId ? [] : [row(5)])) })
    expect((await loadPostEnd(post, [term(9, "category")], "", { inCategory: true }, src)).inCategory).toBeNull()
  })

  it("uses the caller's URL structure without fetching settings", async () => {
    const getUrlStructure = vi.fn(async () => "slug")
    const end = await loadPostEnd(post, [], "", { urlStructure: "id" }, source({ getUrlStructure }))
    expect(getUrlStructure).not.toHaveBeenCalled()
    expect(end.previous?.href).toBe("/post/1")
  })

  it("keeps null ends", async () => {
    const end = await loadPostEnd(post, [], "", {}, source({ getAdjacentPosts: async () => ({ previous: null, next: row(3) }) }))
    expect(end.previous).toBeNull()
    expect(end.next?.post.id).toBe(3)
  })

  it("fails soft: a failed lookup leaves only that part out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const end = await loadPostEnd(
      post,
      [term(9, "category")],
      "",
      { inCategory: true },
      source({
        getAdjacentPosts: async () => {
          throw new Error("down")
        },
        getUrlStructure: async () => {
          throw new Error("down")
        },
      }),
    )
    expect(end.previous).toBeNull()
    expect(end.next).toBeNull()
    // The URL structure falls back to ids.
    expect(end.related.map((r) => r.href)).toEqual(["/post/5", "/post/6"])
    expect(end.inCategory?.posts).toHaveLength(1)
    warn.mockRestore()
  })
})
