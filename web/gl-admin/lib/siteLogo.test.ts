import { describe, expect, it } from "vitest"
import type { Media } from "@gl-admin/lib/api/types"
import { currentLogoLabel, logoMeta, summaryFromMedia, summaryFromSaved } from "./siteLogo"

// Settings › General's "Site logo" (#488, the redesign canvas's Settings board).

describe("the site logo field's rules", () => {
  it("says the file's type and size, as the board does", () => {
    expect(logoMeta("leaf-mark.svg", 512, 512)).toBe("SVG · 512 × 512")
    expect(logoMeta("leaf-mark.png", 0, 0)).toBe("PNG")
    expect(logoMeta(undefined)).toBe("FILE")
  })

  it("reads a picked media item and the saved logo the same way", () => {
    const media = {
      id: 7,
      name: "Leaf mark",
      alt: "A green leaf",
      media_path: "/uploads/media/leaf-0123.svg",
      original_filename: "leaf-mark.svg",
      mime_type: "image/svg+xml",
      width: 512,
      height: 512,
      changed_at: "2026-11-14T10:00:00Z",
      variants: {},
    } as unknown as Media
    const picked = summaryFromMedia(media)
    const saved = summaryFromSaved({
      id: 7,
      media_path: "/uploads/media/leaf-0123.svg",
      width: 512,
      height: 512,
      alt: "A green leaf",
      mime_type: "image/svg+xml",
      name: "Leaf mark",
      filename: "leaf-mark.svg",
    })
    for (const summary of [picked, saved]) {
      expect(summary).toMatchObject({ id: 7, name: "leaf-mark.svg", meta: "SVG · 512 × 512", alt: "A green leaf" })
      expect(currentLogoLabel(summary)).toBe("Current logo: A green leaf")
    }
    expect(currentLogoLabel({ ...saved, alt: " " })).toBe("Current logo: leaf-mark.svg")
  })
})
