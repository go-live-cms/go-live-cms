import { describe, expect, it } from "vitest"
import { presenceColor, safeAvatarSrc } from "./presence"

describe("presenceColor", () => {
  it("is the account's, id % 8", () => {
    expect(presenceColor(1)).toBe("var(--presence-2)")
    expect(presenceColor(8)).toBe("var(--presence-1)")
    expect(presenceColor(-3)).toBe("var(--presence-4)")
  })
})

// #334: awareness is whatever another client says, so only the API's avatar paths
// may become an <img src>.
describe("safeAvatarSrc", () => {
  it("accepts the API's avatar paths", () => {
    for (const src of [
      "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg",
      "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.png",
      "/uploads/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg",
    ]) {
      expect(safeAvatarSrc(src)).toBe(src)
    }
  })

  it("refuses anything else", () => {
    for (const src of [
      null,
      undefined,
      42,
      { src: "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg" },
      "",
      "https://tracker.example/pixel.gif",
      "//tracker.example/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg",
      "/uploads/media/hero-0123456789abcdef0123456789abcdef.jpg",
      "/uploads/media/_avatars/avatar-0123.jpg",
      "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.svg",
      "/uploads/../_avatars/avatar-0123456789abcdef0123456789abcdef.jpg",
      "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg?x=1",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
    ]) {
      expect(safeAvatarSrc(src)).toBeNull()
    }
  })
})