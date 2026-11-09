import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import vectors from "./embedVectors.json"
import {
  capEmbedTitle,
  EMBED_PROVIDER_SPECS,
  EMBED_PROVIDERS,
  EMBED_TITLE_MAX_LENGTH,
  embedFrameHosts,
  embedFrameLabel,
  embedIconOf,
  embedPreviewFrame,
  embedProviderList,
  embedStoredAttrs,
  embedTargetOf,
  isEmbedProvider,
  isValidEmbedRef,
  knownEmbedProviders,
  normalizeEmbedTitle,
  validateBlockDoc,
} from "./index"

// The embed block's rules (#425). `embedVectors.json` is read by the API's tests too, so a
// ref one side accepts can't be refused by the other (a refused store loses the block's
// latest version).

describe("the shared vectors", () => {
  it("lists the providers in the table's order", () => {
    expect(vectors.providers).toEqual([...EMBED_PROVIDERS])
  })

  describe.each(Object.entries(vectors.refs))("%s", (provider, refs) => {
    it.each(refs.valid)("accepts %j", (ref) => expect(isValidEmbedRef(provider, ref)).toBe(true))
    it.each(refs.invalid)("refuses %j", (ref) => expect(isValidEmbedRef(provider, ref)).toBe(false))
  })

  it.each(vectors.canonical)("$provider's page for $ref", ({ provider, ref, url }) => {
    expect(EMBED_PROVIDER_SPECS[provider as keyof typeof EMBED_PROVIDER_SPECS].canonical(ref)).toBe(url)
  })

  it.each(vectors.titles)("a title of %j", ({ in: input, out }) => {
    expect(normalizeEmbedTitle(input)).toBe(out)
  })
})

describe("refs", () => {
  it("has no valid refs for an unknown provider, or a non-string", () => {
    expect(isValidEmbedRef("tiktok", "dQw4w9WgXcQ")).toBe(false)
    expect(isValidEmbedRef("youtube", 12)).toBe(false)
    expect(isValidEmbedRef(null, "dQw4w9WgXcQ")).toBe(false)
  })

  it("isn't fooled by another provider's shape", () => {
    expect(isValidEmbedRef("vimeo", "dQw4w9WgXcQ")).toBe(false)
    expect(isValidEmbedRef("youtube", "76979871")).toBe(false)
  })
})

describe("titles", () => {
  it("caps at the limit in code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(EMBED_TITLE_MAX_LENGTH + 5)
    expect([...capEmbedTitle(emoji)]).toHaveLength(EMBED_TITLE_MAX_LENGTH)
    expect([...(normalizeEmbedTitle(emoji) as string)]).toHaveLength(EMBED_TITLE_MAX_LENGTH)
  })

  it("is null for anything but a string", () => {
    for (const value of [12, true, null, undefined, {}]) expect(normalizeEmbedTitle(value)).toBeNull()
  })
})

describe("what a block stores", () => {
  it("keeps a known provider, its valid ref and a clean title", () => {
    expect(embedStoredAttrs({ provider: "x", ref: "20", title: " Post by jack ", src: "https://evil.example" })).toEqual({ provider: "x", ref: "20", title: "Post by jack" })
  })

  it("keeps the provider of an empty block", () => {
    expect(embedStoredAttrs({ provider: "youtube", ref: null, title: null })).toEqual({ provider: "youtube" })
  })

  it("drops a ref that isn't valid for its provider, and every part of an unknown provider but a title", () => {
    expect(embedStoredAttrs({ provider: "youtube", ref: "nope" })).toEqual({ provider: "youtube" })
    expect(embedStoredAttrs({ provider: "tiktok", ref: "x", title: "T" })).toEqual({ title: "T" })
    expect(embedStoredAttrs({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "<b>x</b>" })).toEqual({ provider: "youtube", ref: "dQw4w9WgXcQ" })
  })

  it("can be shown only with a valid provider and ref", () => {
    expect(embedTargetOf({ provider: "vimeo", ref: "76979871" })).toEqual({ provider: "vimeo", ref: "76979871" })
    expect(embedTargetOf({ provider: "vimeo" })).toBeNull()
    expect(embedTargetOf({ provider: "vimeo", ref: "abc" })).toBeNull()
    expect(embedTargetOf({ ref: "76979871" })).toBeNull()
    expect(embedTargetOf(null)).toBeNull()
  })
})

describe("the players", () => {
  const refs = { youtube: "dQw4w9WgXcQ", vimeo: "76979871", x: "20", codepen: "a/b1", soundcloud: "forss/flickermood", spotify: "track/4cOdK2wGLETKBW3PvgPWqT" } as const

  it.each(EMBED_PROVIDERS)("%s frames over HTTPS from its own hosts, sandboxed", (provider) => {
    const frame = embedPreviewFrame(provider, refs[provider])
    const url = new URL(frame.src)
    expect(url.protocol).toBe("https:")
    expect(EMBED_PROVIDER_SPECS[provider].frameHosts).toContain(url.origin)
    expect(frame.sandbox).toContain("allow-scripts")
    expect(frame.sandbox).not.toContain("allow-top-navigation")
    expect(frame.referrerPolicy === "no-referrer" || frame.referrerPolicy === "strict-origin-when-cross-origin").toBe(true)
  })

  it("uses YouTube's cookieless host and sends it only the site's origin", () => {
    const frame = embedPreviewFrame("youtube", refs.youtube)
    expect(frame.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
    expect(frame.referrerPolicy).toBe("strict-origin-when-cross-origin")
  })

  it("carries an unlisted Vimeo video's hash", () => {
    expect(embedPreviewFrame("vimeo", "76979871/8272103f6e").src).toBe("https://player.vimeo.com/video/76979871?dnt=1&h=8272103f6e")
  })

  it("encodes a SoundCloud address in the player's query", () => {
    expect(embedPreviewFrame("soundcloud", "forss/sets/soulhack").src).toBe("https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fsets%2Fsoulhack")
  })

  it("has no iframe for X on the site: the widget makes it", () => {
    expect(EMBED_PROVIDER_SPECS.x.frame).toBeNull()
    expect(EMBED_PROVIDER_SPECS.x.card).toBe(true)
  })

  it("names the frame for a screen reader", () => {
    expect(embedFrameLabel("youtube", "Two editors")).toBe("YouTube player: Two editors")
    expect(embedFrameLabel("x", null)).toBe("X post")
  })
})

describe("lists", () => {
  it("keeps only known providers, in the table's order", () => {
    expect(knownEmbedProviders(["spotify", "loom", "youtube", 3])).toEqual(["youtube", "spotify"])
    expect(knownEmbedProviders(undefined)).toEqual([])
    expect(isEmbedProvider("loom")).toBe(false)
  })

  it("collects each provider's frame hosts once", () => {
    expect(embedFrameHosts(["youtube", "youtube"])).toEqual(["https://www.youtube-nocookie.com"])
    expect(embedFrameHosts([])).toEqual([])
  })

  it("reads as a sentence", () => {
    expect(embedProviderList([])).toBe("")
    expect(embedProviderList(["youtube"])).toBe("YouTube")
    expect(embedProviderList(["youtube", "vimeo", "x"])).toBe("YouTube, Vimeo or X")
    expect(embedProviderList(["youtube", "vimeo"], "and")).toBe("YouTube and Vimeo")
  })

  it("gives each block its icon, the others the link's", () => {
    expect(embedIconOf("codepen")).toBe(embedIconOf(null))
    expect(embedIconOf("x")).not.toBe(embedIconOf("youtube"))
  })
})

describe("validateBlockDoc", () => {
  const doc = (attrs: Record<string, unknown>) => ({
    doc_version: 1,
    blocks_order: ["embed-0001"],
    blocks: { "embed-0001": { id: "embed-0001", type: "embed", version: 1, attrs } },
  })
  const ok = (attrs: Record<string, unknown>) => {
    try {
      validateBlockDoc(doc(attrs))
      return true
    } catch {
      return false
    }
  }

  it("accepts what the bridge writes", () => {
    expect(ok({ provider: "youtube", ref: "dQw4w9WgXcQ", title: "T", caption: [{ type: "text", text: "C" }] })).toBe(true)
    expect(ok({ provider: "x" })).toBe(true)
    expect(ok({})).toBe(true)
  })

  it("refuses what it never writes", () => {
    expect(ok({ provider: "tiktok" })).toBe(false)
    expect(ok({ provider: "youtube", ref: "nope" })).toBe(false)
    expect(ok({ ref: "dQw4w9WgXcQ" })).toBe(false)
    expect(ok({ provider: "youtube", title: "<b>x</b>" })).toBe(false)
    expect(ok({ provider: "youtube", title: " untrimmed " })).toBe(false)
  })
})

describe("the API's list", () => {
  it("is this table's", () => {
    const go = readFileSync(path.resolve("../api/settings_utils.go"), "utf8")
    const list = /var embedProviders = \[\]string\{([^}]*)\}/.exec(go)?.[1] ?? ""
    expect([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...EMBED_PROVIDERS])
  })
})
