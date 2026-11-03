import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Media, PostSEOSettings } from "@gl-admin/lib/api/types"
import { EMPTY_SEO } from "@gl-admin/lib/postSeo"

// The SEO tab (#357): fallbacks in the previews, soft counters, the switch, the
// canonical URL check, the social image and the view-only state.

const getMediaById = vi.fn()
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: (...args: unknown[]) => getMediaById(...args),
  getMedia: async () => ({ data: [], meta: {} }),
}))
const PostSeoPanel = (await import("./PostSeoPanel")).default

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  getMediaById.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const featured: Media = {
  id: 5, name: "cabin", description: "", alt: "A cabin", media_path: "/uploads/media/cabin.jpg", user_id: 1,
  created_at: "", changed_at: "", file_size: 1, mime_type: "image/jpeg", original_filename: "cabin.jpg", width: 800, height: 600,
  variants: { social: { path: "/uploads/media/_variants/cabin.jpg/social.jpg", width: 800, height: 420 } } as Media["variants"],
}

let changes: PostSEOSettings[] = []
function Harness(props: { initial?: PostSEOSettings; readOnly?: boolean; excerpt?: string; featuredImage?: Media | null; pending?: boolean }) {
  const [seo, setSeo] = useState(props.initial ?? EMPTY_SEO)
  return (
    <PostSeoPanel
      seo={seo}
      onChange={(next) => {
        changes.push(next)
        setSeo(next)
      }}
      readOnly={props.readOnly}
      postTitle="Shipping real-time collaboration in GoLive"
      excerpt={props.excerpt ?? "Two people can now edit the same post at once."}
      firstParagraph="Until this release, two people opening the same post meant one of them lost their changes."
      featuredImage={props.featuredImage === undefined ? featured : props.featuredImage}
      siteName="GoLive Blog"
      siteAddress="https://blog.golive.dev"
      path="/post/real-time-collaboration"
      pending={props.pending}
      liveTitle="Real-time collaboration, explained"
    />
  )
}

function render(props: Parameters<typeof Harness>[0] = {}) {
  changes = []
  act(() => root.render(<Harness {...props} />))
}

const q = <T extends Element = HTMLElement>(selector: string) => container.querySelector(selector) as T | null
const byLabel = (text: string) => {
  const label = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim().startsWith(text))
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | HTMLTextAreaElement | null) : null
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const click = (el: Element | null) => act(() => (el as HTMLElement).click())

describe("PostSeoPanel", () => {
  it("empty: every field falls back, and the previews show the fallbacks", () => {
    render()
    const title = byLabel("SEO title")!
    expect(title.value).toBe("")
    expect(title.placeholder).toBe("Shipping real-time collaboration in GoLive")
    expect(container.textContent).toContain("Uses the post title")
    expect(container.textContent).toContain("Uses the excerpt")
    expect(q(".post-seo__serp-title")!.textContent).toBe("Shipping real-time collaboration in GoLive")
    expect(q(".post-seo__serp-desc")!.textContent).toBe("Two people can now edit the same post at once.")
    expect(q(".post-seo__serp-url")!.textContent).toBe("blog.golive.dev › post › real-time-collaboration")
    expect(container.textContent).toContain("Uses the featured image")
    expect(q<HTMLImageElement>(".post-seo__image img")!.getAttribute("src")).toContain("social.jpg")
  })

  it("no excerpt and no featured image: the first paragraph, and an empty drop zone", () => {
    render({ excerpt: "", featuredImage: null })
    expect(container.textContent).toContain("Uses the first paragraph")
    expect(q(".post-seo__drop")).not.toBeNull()
    expect(container.textContent).toContain("Shared links show text only")
    expect(q(".post-seo__card img")).toBeNull()
  })

  it("typing updates the preview and the aria-live counter, past the guide without blocking", () => {
    render()
    const title = byLabel("SEO title")!
    type(title, "Real-time collaboration in GoLive: how two editors share one draft, live")
    expect(changes.at(-1)!.seo_title).toBe("Real-time collaboration in GoLive: how two editors share one draft, live")
    const counter = document.getElementById(title.getAttribute("aria-describedby")!.split(" ")[1])!
    expect(counter.getAttribute("aria-live")).toBe("polite")
    expect(counter.classList.contains("is-over")).toBe(true)
    expect(counter.textContent).toContain("72 of 60 characters. Search results may cut it off.")
    expect(title.className).toContain("is-over")
    expect(q(".post-seo__serp-title")!.textContent!.endsWith("…")).toBe(true)

    const desc = byLabel("Meta description")!
    type(desc, "Own description")
    expect(changes.at(-1)!.seo_description).toBe("Own description")
    expect(q(".post-seo__serp-desc")!.textContent).toBe("Own description")
  })

  it("Hide from search engines is a switch with its note as the description", () => {
    render()
    const sw = q('[role="switch"]')!
    expect(sw.getAttribute("aria-checked")).toBe("false")
    click(sw)
    expect(changes.at(-1)!.noindex).toBe(true)
    expect(sw.getAttribute("aria-checked")).toBe("true")
    const note = document.getElementById(sw.getAttribute("aria-describedby")!)!
    expect(note.textContent).toContain("left out of the sitemap")
  })

  it("Advanced is a disclosure; an invalid canonical URL is marked and explained", () => {
    render()
    const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Advanced"))!
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(byLabel("Canonical URL")).toBeNull()
    click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    const canon = byLabel("Canonical URL") as HTMLInputElement
    type(canon, "blog.golive.dev/guides collaboration")
    expect(canon.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(canon.getAttribute("aria-describedby")!)!.textContent).toContain("Start it with https://")
    type(canon, "https://blog.golive.dev/guides/collaboration")
    expect(canon.getAttribute("aria-invalid")).toBeNull()
    expect(container.textContent).toContain("treat this address as the original")
  })

  it("a chosen social image is loaded, and Remove goes back to the featured image", async () => {
    getMediaById.mockResolvedValue({ media: { ...featured, id: 12, name: "collab-share", variants: {}, width: 1200, height: 630 } })
    render({ initial: { ...EMPTY_SEO, social_image_id: 12 } })
    await act(async () => {})
    expect(getMediaById).toHaveBeenCalledWith(12)
    expect(container.textContent).toContain("collab-share · 1200 × 630")
    const remove = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Remove")!
    click(remove)
    expect(changes.at(-1)!.social_image_id).toBeNull()
    expect(container.textContent).toContain("Uses the featured image")
  })

  it("a published post with a pending change says so, with the live title", () => {
    render({ pending: true, initial: { ...EMPTY_SEO, seo_title: "A new SEO title" } })
    expect(container.textContent).toContain("Preview · not published yet")
    expect(container.textContent).toContain("Live: Real-time collaboration, explained")
  })

  it("view-only: read-only fields (not disabled), an aria-disabled switch, and nothing changes", () => {
    render({ readOnly: true, initial: { ...EMPTY_SEO, seo_title: "Theirs" } })
    expect(container.textContent).toContain("View-only")
    const title = byLabel("SEO title") as HTMLInputElement
    expect(title.readOnly).toBe(true)
    expect(title.disabled).toBe(false)
    const sw = q('[role="switch"]')!
    expect(sw.getAttribute("aria-disabled")).toBe("true")
    click(sw)
    type(title, "Mine")
    expect(changes).toEqual([])
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Change")).toBe(false)
  })
})
