import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { authManager } from "../auth"
import { getMediaPreviewURL, getMediaVariantPreviewURL, MediaUploadError, replaceMediaFile } from "./media"

// A scripted XMLHttpRequest: each send() answers with the next response and
// reports one progress event first.
type Scripted = { status: number; body: unknown }

function installFakeXHR(responses: Scripted[]) {
  const sent: { url: string; headers: Record<string, string>; body: FormData }[] = []

  class FakeXHR {
    status = 0
    responseText = ""
    withCredentials = false
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
      onprogress: null,
    }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private url = ""
    private headers: Record<string, string> = {}

    open(_method: string, url: string) {
      this.url = url
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value
    }
    send(body: FormData) {
      sent.push({ url: this.url, headers: this.headers, body })
      const next = responses.shift()
      queueMicrotask(() => {
        if (!next) return this.onerror?.()
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
        this.status = next.status
        this.responseText = JSON.stringify(next.body)
        this.onload?.()
      })
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXHR)
  return sent
}

const FRESH_LOOKING = { access_token: "stale-token", expires_at: Math.floor(Date.now() / 1000) + 15 * 60 }
const replaced = { media: { id: 7, name: "Hero", alt: "Alt", media_path: "/uploads/media/hero.png" } }

describe("replaceMediaFile", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    authManager.adoptAccessToken(FRESH_LOOKING)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("posts the file to /media/:id/replace with the bearer token and reports progress", async () => {
    const sent = installFakeXHR([{ status: 200, body: replaced }])
    const progress: number[] = []
    const file = new File(["png"], "new.png", { type: "image/png" })

    await expect(replaceMediaFile(7, file, (f) => progress.push(f))).resolves.toEqual(replaced)

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe("/api/v1/media/7/replace")
    expect(sent[0].headers.Authorization).toBe("Bearer stale-token")
    expect(sent[0].body.get("file")).toBe(file)
    expect(progress).toEqual([0.5])
  })

  it("surfaces the server's error message and status", async () => {
    installFakeXHR([{ status: 400, body: { error: "replacement must be the same file type as the original" } }])

    const err = await replaceMediaFile(7, new File(["x"], "new.jpg")).catch((e) => e)
    expect(err).toBeInstanceOf(MediaUploadError)
    expect(err.message).toBe("Replacement must be the same file type as the original.")
    expect(err.status).toBe(400)
  })

  it("never shows a raw status for permission errors", async () => {
    installFakeXHR([{ status: 403, body: { error: "forbidden" } }])

    const err = await replaceMediaFile(7, new File(["x"], "new.jpg")).catch((e) => e)
    expect(err.message).toMatch(/don't have permission/)
    expect(err.status).toBe(403)
  })

  it("refreshes once on 401 and retries with the new token", async () => {
    const sent = installFakeXHR([
      { status: 401, body: { error: "token expired" } },
      { status: 200, body: replaced },
    ])
    vi.spyOn(authManager, "forceRefresh").mockImplementation(async () => {
      authManager.adoptAccessToken({ ...FRESH_LOOKING, access_token: "new-token" })
      return true
    })

    await expect(replaceMediaFile(7, new File(["png"], "new.png"))).resolves.toEqual(replaced)
    expect(sent.map((s) => s.headers.Authorization)).toEqual(["Bearer stale-token", "Bearer new-token"])
  })

  it("reports a network failure", async () => {
    installFakeXHR([])
    await expect(replaceMediaFile(7, new File(["png"], "new.png"))).rejects.toThrow("Network error")
  })
})

describe("getMediaPreviewURL", () => {
  it("versions the URL by changed_at so a replaced file is refetched", () => {
    const changedAt = "2026-10-22T10:00:00Z"
    expect(getMediaPreviewURL({ media_path: "/uploads/media/hero.png", changed_at: changedAt })).toBe(
      `/uploads/media/hero.png?v=${Date.parse(changedAt)}`
    )
  })

  it("leaves the URL alone without a usable changed_at", () => {
    expect(getMediaPreviewURL({ media_path: "uploads/media/a.png", changed_at: "" })).toBe("/uploads/media/a.png")
    // The column's default before the first update.
    expect(getMediaPreviewURL({ media_path: "/uploads/media/a.png", changed_at: "0001-01-01T00:00:00Z" })).toBe("/uploads/media/a.png")
  })
})

describe("getMediaVariantPreviewURL", () => {
  const changedAt = "2026-10-22T10:00:00Z"
  const v = `?v=${Date.parse(changedAt)}`
  const variant = (name: string) => ({
    path: `/uploads/media/_variants/hero.jpg/${name}.jpg`,
    width: 1,
    height: 1,
    mime_type: "image/jpeg",
    file_size: 1,
  })

  it("uses the requested variant, versioned like the original", () => {
    const media = {
      media_path: "/uploads/media/hero.jpg",
      changed_at: changedAt,
      variants: { thumb: variant("thumb"), medium: variant("medium") },
    }
    expect(getMediaVariantPreviewURL(media, "thumb")).toBe(`/uploads/media/_variants/hero.jpg/thumb.jpg${v}`)
    expect(getMediaVariantPreviewURL(media, "medium")).toBe(`/uploads/media/_variants/hero.jpg/medium.jpg${v}`)
  })

  it("falls back to the next larger variant, then the original", () => {
    // A 1000px image has no large variant; a 300px one has none at all.
    const mid = { media_path: "/uploads/media/hero.jpg", changed_at: changedAt, variants: { medium: variant("medium") } }
    expect(getMediaVariantPreviewURL(mid, "thumb")).toBe(`/uploads/media/_variants/hero.jpg/medium.jpg${v}`)
    expect(getMediaVariantPreviewURL(mid, "large")).toBe(`/uploads/media/hero.jpg${v}`)
    expect(getMediaVariantPreviewURL({ media_path: "/uploads/media/a.png", changed_at: changedAt, variants: {} })).toBe(
      `/uploads/media/a.png${v}`
    )
    expect(getMediaVariantPreviewURL({ media_path: "/uploads/media/a.png", changed_at: changedAt })).toBe(
      `/uploads/media/a.png${v}`
    )
  })
})
