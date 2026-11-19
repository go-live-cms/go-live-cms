import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ImportItem, ImportJob, ImportSummary } from "@gl-admin/lib/api/imports"

// The Import page (#150) on a mocked API client: choosing a file, the mapping step, the
// progress and the report.

const api = vi.hoisted(() => ({
  uploadImport: vi.fn(),
  listImports: vi.fn(),
  getImport: vi.fn(),
  listImportItems: vi.fn(),
  listImportMediaFailures: vi.fn(),
  startImport: vi.fn(),
  cancelImport: vi.fn(),
  deleteImport: vi.fn(),
  getImportNotice: vi.fn(),
  dismissImportNotice: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/imports", () => api)
vi.mock("@gl-admin/lib/api/postTypes", () => ({
  getPostTypes: vi.fn().mockResolvedValue({
    data: [
      { name: "post", label: "Posts", is_active: true },
      { name: "page", label: "Pages", is_active: true },
    ],
  }),
}))
vi.mock("@gl-admin/components/users/MemberPicker", () => ({
  allMembers: vi.fn().mockResolvedValue([{ id: 7, username: "ana", full_name: "Ana Costa", email: "ana@example.test", role: "editor" }]),
}))

import Import from "./Import"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const summary: ImportSummary = {
  source: "wxr",
  site_url: "https://example.com",
  site_host: "example.com",
  items: 5,
  authors: [
    { login: "ana", display_name: "Ana Costa", posts: 2, suggested_user_id: 7, matched_by: "email" },
    { login: "kenji", display_name: "Kenji Sato", posts: 3, suggested_user_id: 0 },
  ],
  types: [
    { type: "post", count: 2, published: 2, suggested: "post" },
    { type: "page", count: 2, published: 1, suggested: "page" },
    { type: "product", count: 1, published: 1, suggested: "" },
  ],
  categories: 5,
  tags: 2,
  other_terms: 0,
  attachments: 5,
  files: 0,
  skipped: {},
  not_imported: { comments: 2 },
}

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 3,
  source: "wxr",
  file_name: "example.wordpress.xml",
  site_url: "https://example.com",
  status: "mapping",
  summary,
  created_by: 1,
  created_at: "2026-11-19T10:00:00Z",
  started_at: null,
  finished_at: null,
  progress: { total: 5, pending: 5, imported: 0, skipped: 0, failed: 0, with_dropped: 0 },
  imported_before: 1,
  ...over,
})

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined

async function click(label: string) {
  const target = button(label)
  expect(target, `button ${label}`).toBeDefined()
  await act(async () => target!.click())
  await settle()
}

async function render(path = "/import") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/import" element={<Import />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  for (const fn of Object.values(api)) fn.mockReset()
  api.listImports.mockResolvedValue([])
  api.listImportItems.mockResolvedValue([])
  api.listImportMediaFailures.mockResolvedValue([])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function chooseFile(file: File) {
  const input = container.querySelector("input[type=file]") as HTMLInputElement
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  return act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("choosing a file", () => {
  it("lists recent imports and opens an upload's mapping", async () => {
    api.listImports.mockResolvedValue([{ ...job(), status: "done", progress: { total: 5, pending: 0, imported: 4, skipped: 1, failed: 0, with_dropped: 1 } }])
    api.uploadImport.mockResolvedValue(job())
    api.getImport.mockResolvedValue(job())
    await render()
    expect(container.querySelector("h1")?.textContent).toBe("Import")
    expect(container.textContent).toContain("Recent imports")
    expect(container.textContent).toContain("4 imported · 1 skipped · 1 with dropped blocks")
    expect(container.textContent).toContain("Finished")

    await chooseFile(new File(["<rss/>"], "example.wordpress.xml", { type: "text/xml" }))
    await settle()
    expect(api.uploadImport).toHaveBeenCalledTimes(1)
    expect(container.querySelector("h1")?.textContent).toBe("Import from WordPress")
  })

  it("shows why a file was refused", async () => {
    api.uploadImport.mockRejectedValue(new ApiError("Request failed", 422, null, "unsafe_zip", "The zip has a link or a path outside its folder, so it wasn’t read"))
    await render()
    await chooseFile(new File(["PK"], "notes.zip"))
    await settle()
    const alert = container.querySelector("[role=alert]")
    expect(alert?.textContent).toContain("outside its folder")
    expect(alert?.textContent).toContain("notes.zip")
  })
})

describe("the mapping step", () => {
  it("maps authors and types, previews and starts", async () => {
    api.getImport.mockResolvedValue(job())
    api.startImport.mockResolvedValue(job({ status: "running", progress: { total: 5, pending: 3, imported: 2, skipped: 0, failed: 0, with_dropped: 0 } }))
    await render("/import?id=3")
    expect(container.textContent).toContain("Authors")
    expect(container.textContent).toContain("ana · 2 posts · same email as a member")
    expect(container.textContent).toContain("Products (product)")
    expect(container.textContent).toContain("2 posts, 2 pages, 5 categories and 2 tags and the images they use from example.com.")
    expect(container.textContent).toContain("1 item was imported before and will be skipped. Not imported: 1 product and 2 comments.")
    // The server's answer while it runs.
    api.getImport.mockResolvedValue(job({ status: "running", progress: { total: 5, pending: 3, imported: 2, skipped: 0, failed: 0, with_dropped: 0 } }))
    await click("Import 4 items")
    expect(api.startImport).toHaveBeenCalledWith(3, { authors: { ana: 7, kenji: 0 }, types: { post: "post", page: "page", product: "" } })
    expect(container.querySelector("h1")?.textContent).toBe("Importing from WordPress")
    expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")).toBe("2")
    expect(container.textContent).toContain("2 of 5 items")
  })

  it("discards an import that hasn't started", async () => {
    api.getImport.mockResolvedValue(job())
    api.deleteImport.mockResolvedValue(undefined)
    await render("/import?id=3")
    await click("Discard")
    expect(api.deleteImport).toHaveBeenCalledWith(3)
    expect(container.querySelector("h1")?.textContent).toBe("Import")
  })
})

describe("the report", () => {
  const item = (over: Partial<ImportItem>): ImportItem => ({
    id: 1,
    position: 1,
    type: "post",
    title: "Migrating from WordPress",
    status: "imported",
    post_id: 11,
    post_type: "post",
    post_status: "published",
    result: {},
    processed_at: null,
    ...over,
  })

  it("lists items, dropped blocks with their original, and failed images", async () => {
    const done = job({ status: "done", progress: { total: 3, pending: 0, imported: 2, skipped: 1, failed: 0, with_dropped: 1 } })
    api.getImport.mockResolvedValue(done)
    const rows = [
      item({
        result: {
          dropped: [{ label: "Shortcode [contact-form-7]", after: "Get in touch", original: "[contact-form-7 id=5]" }],
          media_failed: [{ url: "cdn.other.net/a.png", code: "other_host", reason: "Images are only downloaded from the export’s own site" }],
          redirects: ["/2024/05/migrating"],
        },
      }),
      item({ id: 2, title: "About", post_type: "page" }),
      item({ id: 3, title: "Hello world!", status: "skipped", reason: "imported_before", post_id: null, post_status: undefined }),
    ]
    api.listImportItems.mockResolvedValue(rows)
    api.listImportMediaFailures.mockResolvedValue([
      { item_id: 1, post: "Migrating from WordPress", url: "cdn.other.net/a.png", code: "other_host", reason: "Images are only downloaded from the export’s own site" },
    ])
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    await render("/import?id=3")
    expect(container.querySelector("h1")?.textContent).toBe("Import finished")
    expect(container.textContent).toContain("2 imported · 1 skipped · 1 with dropped blocks · 1 image failed")
    expect(container.textContent).toContain("1 block couldn’t be kept")
    expect(container.textContent).toContain("Shortcode [contact-form-7] — after “Get in touch”")
    expect(container.textContent).toContain("The old address redirects here: /2024/05/migrating")
    expect(container.textContent).toContain("Skipped · Imported before")
    expect(container.textContent).toContain("Images that couldn’t be added")
    expect(container.textContent).toContain("cdn.other.net/a.png · in “Migrating from WordPress”")
    expect(container.querySelector("a[href='/content/edit/11']")).not.toBeNull()
    await click("Copy the original as text")
    expect(writeText).toHaveBeenCalledWith("[contact-form-7 id=5]")
  })
})
