import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The new-post chooser (#322): Blank or a template, and the templates manager inside it
// (rename, delete) for admins and editors.

const api = vi.hoisted(() => ({
  listPostTemplates: vi.fn(),
  createPostFromTemplate: vi.fn(),
  renamePostTemplate: vi.fn(),
  deletePostTemplate: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/postTemplates", () => api)

import NewPostDialog from "./NewPostDialog"
import { toast } from "@gl-admin/components/ui/Toast"
import { ApiError } from "@gl-admin/lib/api/errors"
import { fromTemplateMessage } from "@gl-admin/lib/postTemplates"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const template = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  post_type: "post",
  name,
  terms: [],
  featured_image_id: null,
  created_by_id: 7,
  created_by_name: "Elena V.",
  created_at: "2026-11-01T10:00:00Z",
  changed_at: "2026-11-01T10:00:00Z",
  ...extra,
})

function Editor() {
  const { id } = useParams()
  return <p data-testid="editor">Editing post {id}</p>
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

async function render({ canManage = true, onClose = vi.fn() } = {}) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<NewPostDialog isOpen onClose={onClose} postType="post" noun="post" canManage={canManage} />} />
          <Route path="/content/:type/new" element={<p data-testid="blank">Blank editor</p>} />
          <Route path="/content/edit/:id" element={<Editor />} />
        </Routes>
      </MemoryRouter>
    )
  })
  await settle()
  return onClose
}

const options = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>(".gl-template-chooser__option")).map((b) => b.textContent)
const option = (name: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button.gl-template-chooser__option")).find((b) =>
    b.querySelector(".gl-template-chooser__name")?.textContent === name
  )!
const click = async (el: HTMLElement | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => el!.click())
  await settle()
}
const menuItem = (label: string) => Array.from(container.querySelectorAll<HTMLElement>("[role='menuitem']")).find((m) => m.textContent === label)
const buttonByText = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label)

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  for (const fn of Object.values(api)) fn.mockReset()
  api.listPostTemplates.mockResolvedValue([
    template(1, "Release notes", { terms: [{ id: 3, name: "Changelog" }], featured_image_id: 9 }),
    template(2, "Weekly update"),
  ])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("New post: Blank or from a template", () => {
  it("lists Blank first, then the type's templates with what they bring", async () => {
    await render()
    expect(api.listPostTemplates).toHaveBeenCalledWith("post")
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("New post")
    expect(options()).toEqual([
      "Blank postAn empty post",
      "Release notesContent · Category: Changelog · Featured image",
      "Weekly updateContent only",
    ])
  })

  it("Blank opens the editor on a new post", async () => {
    const onClose = await render()
    await click(option("Blank post"))
    expect(onClose).toHaveBeenCalled()
    expect(container.querySelector("[data-testid='blank']")).not.toBeNull()
    expect(api.createPostFromTemplate).not.toHaveBeenCalled()
  })

  it("a template makes a draft and opens it, with a toast", async () => {
    const success = vi.spyOn(toast, "success")
    api.createPostFromTemplate.mockResolvedValue({ post: { id: 501, title: "Weekly update" } })
    await render()
    await click(option("Weekly update"))
    expect(api.createPostFromTemplate).toHaveBeenCalledWith(2)
    expect(success).toHaveBeenCalledWith(fromTemplateMessage("Weekly update"))
    expect(container.querySelector("[data-testid='editor']")?.textContent).toBe("Editing post 501")
  })

  it("stays open and says why when making the post fails", async () => {
    api.createPostFromTemplate.mockRejectedValue(new ApiError("The template's content is no longer valid.", 400))
    await render()
    await click(option("Weekly update"))
    expect(container.querySelector("[role='alert']")?.textContent).toContain("no longer valid")
    expect(container.querySelector("[data-testid='editor']")).toBeNull()
    expect(option("Weekly update").disabled).toBe(false)
  })

  it("still offers Blank when the templates can't be loaded", async () => {
    api.listPostTemplates.mockRejectedValue(new Error("offline"))
    await render()
    expect(options()).toEqual(["Blank postAn empty post"])
    expect(container.textContent).toContain("offline")
  })

  it("says how to make one when there are none", async () => {
    api.listPostTemplates.mockResolvedValue([])
    await render()
    expect(container.textContent).toContain("No post templates yet. To make one, choose Save as template…")
    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ canManage: false })
    expect(container.textContent).toContain("No post templates yet.")
    expect(container.textContent).not.toContain("Save as template")
  })
})

describe("Managing templates", () => {
  const manage = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label='Manage “${name}”']`)

  it("contributors can use templates but not manage them", async () => {
    await render({ canManage: false })
    expect(manage("Weekly update")).toBeNull()
    expect(option("Weekly update")).toBeTruthy()
  })

  it("renames in place and keeps the list in name order", async () => {
    api.renamePostTemplate.mockResolvedValue(template(2, "Annual report"))
    await render()
    await click(manage("Weekly update"))
    await click(menuItem("Rename"))
    const input = container.querySelector<HTMLInputElement>("#gl-template-rename-2")!
    expect(input.value).toBe("Weekly update")
    await type(input, "  Annual report ")
    await click(buttonByText("Save name"))
    expect(api.renamePostTemplate).toHaveBeenCalledWith(2, "Annual report")
    expect(options().map((o) => o?.split("Content")[0])).toEqual(["Blank postAn empty post", "Annual report", "Release notes"])
  })

  it("checks the name first, and shows the API's name conflict on the field", async () => {
    api.renamePostTemplate.mockRejectedValue(new ApiError("taken", 409, null, "template_name_taken"))
    await render()
    await click(manage("Weekly update"))
    await click(menuItem("Rename"))
    const input = container.querySelector<HTMLInputElement>("#gl-template-rename-2")!
    await type(input, "ab")
    await click(buttonByText("Save name"))
    expect(api.renamePostTemplate).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Use at least 3 characters.")

    await type(input, "Release notes")
    await click(buttonByText("Save name"))
    expect(api.renamePostTemplate).toHaveBeenCalledWith(2, "Release notes")
    expect(container.textContent).toContain("There's already a post template named “Release notes”.")
  })

  it("deletes after asking, and says posts made from it keep their content", async () => {
    const success = vi.spyOn(toast, "success")
    api.deletePostTemplate.mockResolvedValue(undefined)
    await render()
    await click(manage("Weekly update"))
    await click(menuItem("Delete"))
    expect(api.deletePostTemplate).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Delete Weekly update? Posts made from it keep their content.")
    await click(buttonByText("Delete template"))
    expect(api.deletePostTemplate).toHaveBeenCalledWith(2)
    expect(options().map((o) => o?.split("Content")[0])).toEqual(["Blank postAn empty post", "Release notes"])
    expect(success).toHaveBeenCalledWith(expect.stringContaining("keep their content"))
  })

  it("Cancel keeps the template", async () => {
    await render()
    await click(manage("Weekly update"))
    await click(menuItem("Delete"))
    await click(buttonByText("Cancel"))
    expect(api.deletePostTemplate).not.toHaveBeenCalled()
    expect(option("Weekly update")).toBeTruthy()
  })
})
