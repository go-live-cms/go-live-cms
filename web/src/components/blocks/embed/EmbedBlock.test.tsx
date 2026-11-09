// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import path from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import BlockRenderer, { EMBED_LOADER_SRC } from "../../BlockRenderer"
import { EMBED_PROVIDER_SPECS, EMBED_PROVIDERS, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"

// The published embed (#425): a placeholder and nothing that loads anything, until a click.
// The first block of tests reads the markup a page is served with; the second runs the real
// public/gl-embeds.js against it.

const REFS = { youtube: "dQw4w9WgXcQ", vimeo: "76979871", x: "20", codepen: "chriscoyier/gfdDu", soundcloud: "forss/flickermood", spotify: "track/4cOdK2wGLETKBW3PvgPWqT" } as const

function docOf(blocks: Record<string, any>, order = Object.keys(blocks)): BlockDocV1 {
  return { doc_version: 1, blocks_order: order, blocks: Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, { id, version: 1, ...b }])) } as unknown as BlockDocV1
}

const embed = (attrs: Record<string, unknown>) => ({ type: "embed", attrs })
const html = (doc: BlockDocV1) => renderToStaticMarkup(<BlockRenderer doc={doc} />)
const everyProvider = () => docOf(Object.fromEntries(EMBED_PROVIDERS.map((provider) => [`embed-${provider}`, embed({ provider, ref: REFS[provider], title: `A ${provider} title` })])))

describe("the rendered page", () => {
  it("is a placeholder: provider, title, Load video and where it connects", () => {
    const page = html(docOf({ "embed-0001": embed({ provider: "youtube", ref: REFS.youtube, title: "Two editors, one draft" }) }))
    expect(page).toContain('class="embed-frame"')
    expect(page).toContain("YouTube video")
    expect(page).toContain("Two editors, one draft")
    expect(page).toContain(">Load video</button>")
    expect(page).toContain("Loading it connects to <!-- -->youtube.com".replace("<!-- -->", ""))
    expect(page).toContain('aria-label="Load video: Two editors, one draft"')
  })

  it("makes no third-party request: no iframe, image, link or foreign script, nor a provider's address", () => {
    const page = html(everyProvider())
    expect(page).not.toMatch(/<iframe|<img|<link|<object|<embed|<video|<audio|srcset/)
    expect(page).not.toMatch(/https?:/)
    expect(page).not.toContain("//")
    for (const provider of EMBED_PROVIDERS) {
      expect(page).toContain(`data-embed-ref="${REFS[provider]}"`)
    }
    const scripts = [...page.matchAll(/<script[^>]*>/g)].map((m) => m[0])
    expect(scripts).toEqual([`<script src="${EMBED_LOADER_SRC}" defer=""></script>`.replace("</script>", "")])
  })

  it("loads its script from this site, once, however many embeds there are", () => {
    expect(EMBED_LOADER_SRC.startsWith("/")).toBe(true)
    expect(EMBED_LOADER_SRC.startsWith("//")).toBe(false)
    expect(html(everyProvider()).match(/<script/g)).toHaveLength(1)
  })

  it("has no script at all on a post without an embed", () => {
    expect(html(docOf({ "para-00001": { type: "paragraph", attrs: { text: "Hello" } } }))).not.toContain("<script")
  })

  it("draws X as a card and audio players short", () => {
    const page = html(everyProvider())
    expect(page).toContain('class="embed-frame is-card" data-embed-provider="x"')
    expect(page).toContain('class="embed-frame is-compact" data-embed-provider="spotify"')
    expect(page).toContain("Post on X")
    expect(page).toContain(">Load post</button>")
  })

  it("renders the caption under the frame, with its marks", () => {
    const page = html(docOf({ "embed-0001": embed({ provider: "vimeo", ref: REFS.vimeo, caption: [{ type: "text", text: "From ", marks: [{ type: "bold" }] }, { type: "text", text: "October" }] }) }))
    expect(page).toContain("<figcaption><strong>From </strong>October</figcaption>")
  })

  it("names an untitled embed after its provider", () => {
    const page = html(docOf({ "embed-0001": embed({ provider: "vimeo", ref: REFS.vimeo }) }))
    expect(page).toContain('<p class="embed-title">Vimeo video</p>')
    expect(page).toContain('aria-label="Load video: Vimeo video"')
  })

  it("escapes a title and never reads it as HTML", () => {
    const page = html(docOf({ "embed-0001": embed({ provider: "vimeo", ref: REFS.vimeo, title: "<script>alert(1)</script>" }) }))
    expect(page).not.toContain("alert(1)")
    expect(html(docOf({ "embed-0001": embed({ provider: "vimeo", ref: REFS.vimeo, title: "a < b & c" }) }))).toContain("a &lt; b &amp; c")
  })

  it("gives a top-level embed its block anchor, and one in a group none", () => {
    const page = html(
      docOf(
        {
          "embed-0001": embed({ provider: "x", ref: REFS.x }),
          "group-0001": { type: "group", attrs: {}, children: ["embed-0002"] },
          "embed-0002": embed({ provider: "vimeo", ref: REFS.vimeo }),
        },
        ["embed-0001", "group-0001"],
      ),
    )
    expect(page).toContain('id="b-embed-0001"')
    expect(page).not.toContain('id="b-embed-0002"')
    expect(page).toContain('data-embed-ref="76979871"')
    expect(page.match(/<script/g)).toHaveLength(1)
  })

  describe("renders nothing, and adds no script, for", () => {
    it.each([
      ["an empty block", { provider: "youtube" }],
      ["the attrs the API leaves when a provider isn't allowed any more", {}],
      ["an invalid ref", { provider: "youtube", ref: "../../x" }],
      ["an unknown provider", { provider: "tiktok", ref: REFS.youtube }],
    ])("%s", (_name, attrs) => {
      const page = html(docOf({ "embed-0001": embed(attrs) }))
      expect(page).not.toContain("embed-frame")
      expect(page).not.toContain("<script")
      expect(page).not.toContain("<figure")
    })
  })
})

describe("the script", () => {
  const source = readFileSync(path.resolve("public/gl-embeds.js"), "utf8")

  const mount = (doc: BlockDocV1) => {
    document.body.innerHTML = html(doc)
    delete (window as any).__glEmbedsLoaded
    new Function(source)()
  }

  let appended: Element[] = []
  let listeners: EventListenerOrEventListenerObject[] = []

  beforeEach(() => {
    appended = []
    listeners = []
    const add = document.addEventListener.bind(document)
    vi.spyOn(document, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === "click") listeners.push(listener)
      add(type, listener, options as AddEventListenerOptions)
    })
    const original = document.head.appendChild.bind(document.head)
    vi.spyOn(document.head, "appendChild").mockImplementation((node: any) => {
      appended.push(node)
      return original(node)
    })
  })

  afterEach(() => {
    listeners.forEach((listener) => document.removeEventListener("click", listener))
    vi.restoreAllMocks()
    delete (window as any).twttr
    document.body.innerHTML = ""
  })

  const clickLoad = (root: ParentNode = document) => root.querySelector<HTMLButtonElement>("[data-embed-load]")!.click()

  it("asks nothing of a provider before a click", () => {
    mount(everyProvider())
    expect(document.querySelector("iframe")).toBeNull()
    expect(appended).toEqual([])
    expect(document.querySelectorAll("script[src*='twitter']")).toHaveLength(0)
  })

  it.each(EMBED_PROVIDERS.filter((provider) => provider !== "x"))("%s: builds exactly the table's player on click", (provider) => {
    mount(docOf({ "embed-0001": embed({ provider, ref: REFS[provider], title: "The title" }) }))
    clickLoad()
    const iframe = document.querySelector("iframe")!
    const expected = EMBED_PROVIDER_SPECS[provider].frame!(REFS[provider])
    expect(iframe.getAttribute("src")).toBe(expected.src)
    expect(iframe.getAttribute("sandbox")).toBe(expected.sandbox)
    expect(iframe.getAttribute("referrerpolicy")).toBe(expected.referrerPolicy)
    expect(iframe.getAttribute("allow")).toBe(expected.allow)
    expect(iframe.getAttribute("loading")).toBe("lazy")
  })

  it("agrees with the table on every valid and invalid ref of the shared vectors", async () => {
    const vectors = (await import("@gl-admin/lib/blocks-spec/embedVectors.json")).default
    for (const provider of EMBED_PROVIDERS) {
      if (provider === "x") continue
      const { valid, invalid } = vectors.refs[provider]
      for (const ref of [...valid, ...invalid]) {
        document.body.innerHTML = `<div data-embed-provider="${provider}" data-embed-ref="${ref.replace(/"/g, "&quot;")}" data-embed-label="L"><button data-embed-load></button></div>`
        listeners.splice(0).forEach((listener) => document.removeEventListener("click", listener))
        delete (window as any).__glEmbedsLoaded
        new Function(source)()
        clickLoad()
        const iframe = document.querySelector("iframe")
        if (valid.includes(ref)) expect(iframe?.getAttribute("src"), `${provider} ${ref}`).toBe(EMBED_PROVIDER_SPECS[provider].frame!(ref).src)
        else expect(iframe, `${provider} ${ref}`).toBeNull()
      }
    }
  })

  it("replaces the placeholder and moves focus into the player", () => {
    mount(docOf({ "embed-0001": embed({ provider: "youtube", ref: REFS.youtube, title: "Two editors" }) }))
    clickLoad()
    const frame = document.querySelector(".embed-frame")!
    expect(frame.classList.contains("is-loaded")).toBe(true)
    expect(frame.getAttribute("role")).toBe("region")
    expect(frame.getAttribute("aria-label")).toBe("YouTube player: Two editors")
    expect(frame.querySelector("button")).toBeNull()
    const iframe = frame.querySelector("iframe")!
    expect(iframe.title).toBe("YouTube player: Two editors")
    expect(document.activeElement).toBe(iframe)
  })

  it("loads only the embed that was clicked", () => {
    mount(everyProvider())
    clickLoad(document.querySelector("[data-embed-provider='vimeo']")!)
    expect(document.querySelectorAll("iframe")).toHaveLength(1)
    expect(document.querySelectorAll("[data-embed-load]")).toHaveLength(EMBED_PROVIDERS.length - 1)
  })

  it("follows a click on the button's text", () => {
    mount(docOf({ "embed-0001": embed({ provider: "youtube", ref: REFS.youtube }) }))
    const button = document.querySelector("[data-embed-load]")!
    const inner = document.createElement("span")
    button.append(inner)
    inner.click()
    expect(document.querySelector("iframe")).not.toBeNull()
  })

  it("ignores a provider or ref the markup made up", () => {
    document.body.innerHTML = `
      <div data-embed-provider="evil" data-embed-ref="dQw4w9WgXcQ"><button data-embed-load id="a"></button></div>
      <div data-embed-provider="youtube" data-embed-ref="https://evil.example"><button data-embed-load id="b"></button></div>
      <div data-embed-provider="constructor" data-embed-ref="dQw4w9WgXcQ"><button data-embed-load id="c"></button></div>
      <div data-embed-provider="x" data-embed-ref="javascript:1"><button data-embed-load id="d"></button></div>`
    delete (window as any).__glEmbedsLoaded
    new Function(source)()
    for (const id of ["a", "b", "c", "d"]) document.getElementById(id)!.click()
    expect(document.querySelector("iframe")).toBeNull()
    expect(appended).toEqual([])
  })

  it("registers one listener however many times it is included", () => {
    mount(docOf({ "embed-0001": embed({ provider: "youtube", ref: REFS.youtube }) }))
    new Function(source)()
    clickLoad()
    expect(document.querySelectorAll("iframe")).toHaveLength(1)
  })

  describe("X", () => {
    const mountX = () => mount(docOf({ "embed-0001": embed({ provider: "x", ref: REFS.x, title: "Post by jack" }) }))
    const script = () => appended.find((node) => node.tagName === "SCRIPT") as HTMLScriptElement | undefined
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    const stubWidget = (createTweet = vi.fn(async () => document.createElement("div"))) => {
      ;(window as any).twttr = { ready: (done: (t: unknown) => void) => done((window as any).twttr), widgets: { createTweet } }
      return createTweet
    }

    it("requests the widget only after a click, from X's fixed address", () => {
      mountX()
      expect(script()).toBeUndefined()
      clickLoad()
      expect(script()?.src).toBe("https://platform.twitter.com/widgets.js")
    })

    it("hands the widget only the post's id, and moves focus to its region", async () => {
      const createTweet = stubWidget()
      mountX()
      clickLoad()
      script()!.onload!(new Event("load"))
      await flush()
      const frame = document.querySelector(".embed-frame")!
      expect(createTweet).toHaveBeenCalledWith("20", frame, { dnt: true })
      expect(frame.getAttribute("aria-label")).toBe("X post: Post by jack")
      expect(document.activeElement).toBe(frame)
    })

    it("offers Load again when the widget can't be fetched", async () => {
      mountX()
      clickLoad()
      const button = document.querySelector<HTMLButtonElement>("[data-embed-load]")!
      expect(button.disabled).toBe(true)
      script()!.onerror!(new Event("error"))
      await flush()
      expect(button.disabled).toBe(false)
      expect(document.querySelector(".embed-note")!.textContent).toContain("couldn't be loaded")
    })

    it("says so when the post is gone", async () => {
      stubWidget(vi.fn(async () => undefined as unknown as HTMLDivElement))
      mountX()
      clickLoad()
      script()!.onload!(new Event("load"))
      await flush()
      expect(document.querySelector(".embed-frame")!.textContent).toContain("couldn't be loaded")
    })
  })
})
