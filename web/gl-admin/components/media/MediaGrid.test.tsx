import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import MediaGrid from "./MediaGrid"
import type { Media } from "@gl-admin/lib/types"

// The grid's states (#342): loading skeletons, empty, failed, uploading tiles, and
// tiles with the thumb variant.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const media = (id: number, over: Partial<Media> = {}): Media => ({
  id,
  name: `file-${id}.jpg`,
  description: "",
  alt: "",
  media_path: `uploads/file-${id}.jpg`,
  user_id: 1,
  created_at: "2026-10-26T10:00:00Z",
  changed_at: "0001-01-01T00:00:00Z",
  file_size: 412 * 1024,
  mime_type: "image/jpeg",
  width: 2400,
  height: 1500,
  original_filename: `file-${id}.jpg`,
  variants: { thumb: { path: `uploads/file-${id}-thumb.webp`, width: 320, height: 200 } as never },
  ...over,
})

const render = (el: React.ReactElement) => act(() => root.render(el))

describe("MediaGrid", () => {
  it("loading: a busy grid of skeleton tiles, announced once", () => {
    render(<MediaGrid mediaItems={[media(1)]} loading />)
    const grid = container.querySelector("[data-testid=media-grid-loading]")!
    expect(grid.getAttribute("aria-busy")).toBe("true")
    expect(grid.querySelectorAll(".gl-media-tile--skeleton")).toHaveLength(12)
    expect(container.querySelector("[role=status]")?.textContent).toBe("Loading media…")
    // No real tiles while loading, even with items from before.
    expect(container.querySelector("button.gl-media-tile")).toBeNull()
  })

  it("empty: shows the page's empty state", () => {
    render(<MediaGrid mediaItems={[]} empty={<p data-testid="empty">Drop files here to upload</p>} />)
    expect(container.querySelector("[data-testid=empty]")?.textContent).toBe("Drop files here to upload")
    expect(container.querySelector(".gl-media-grid")).toBeNull()
  })

  it("empty but uploading: the upload tiles, not the empty state", () => {
    render(
      <MediaGrid
        mediaItems={[]}
        empty={<p data-testid="empty" />}
        uploads={[
          { key: "a", name: "team.jpg", error: null },
          { key: "b", name: "huge.mov", error: "File too large" },
        ]}
      />
    )
    expect(container.querySelector("[data-testid=empty]")).toBeNull()
    expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-label")).toBe("Uploading team.jpg")
    expect(container.querySelector(".gl-media-tile--upload.is-failed")?.textContent).toContain("Failed · File too large")
  })

  it("error: an alert with a retry", () => {
    render(<MediaGrid mediaItems={[]} error="Server error" onRetry={() => {}} />)
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Server error")
    expect(container.querySelector("button")?.textContent).toContain("Try again")
  })

  it("tiles: the thumb variant, the format tag and the meta line; the open one is pressed", () => {
    render(<MediaGrid mediaItems={[media(1), media(2, { mime_type: "application/pdf", media_path: "uploads/a.pdf", variants: {} })]} activeId={1} />)
    const tiles = container.querySelectorAll<HTMLButtonElement>("button.gl-media-tile")
    expect(tiles).toHaveLength(2)
    expect(tiles[0].querySelector("img")?.getAttribute("src")).toBe("/uploads/file-1-thumb.webp")
    expect(tiles[0].getAttribute("aria-pressed")).toBe("true")
    expect(tiles[0].textContent).toContain("2400 × 1500 · 412 KB")
    expect(tiles[1].querySelector("img")).toBeNull()
    expect(tiles[1].querySelector(".gl-media-tile__tag")?.textContent).toBe("PDF")
    expect(tiles[1].getAttribute("aria-pressed")).toBe("false")
  })

  it("select mode: pressed means selected", () => {
    render(<MediaGrid mediaItems={[media(1), media(2)]} selectable selectedMedia={[media(2)]} activeId={1} />)
    const tiles = container.querySelectorAll("button.gl-media-tile")
    expect(tiles[0].getAttribute("aria-pressed")).toBe("false")
    expect(tiles[1].getAttribute("aria-pressed")).toBe("true")
    expect(tiles[1].querySelector(".gl-media-tile__check.is-checked")).not.toBeNull()
  })
})
