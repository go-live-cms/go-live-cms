import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Plugin, PluginSettings } from "@gl-admin/lib/api/plugins"

// The Plugins page (#11) and its settings panel (#457), on a mocked API client.

const api = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  getPluginSettings: vi.fn(),
  updatePluginSettings: vi.fn(),
  deletePluginData: vi.fn(),
}))

vi.mock("@gl-admin/lib/api/plugins", () => api)

import Plugins from "./Plugins"
import { ApiError } from "@gl-admin/lib/api/errors"
import { toast } from "@gl-admin/components/ui/Toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function plugin(over: Partial<Plugin> = {}): Plugin {
  return {
    id: 1,
    slug: "reading-time",
    name: "Reading time",
    version: "1.2.0",
    author: "Ana Costa",
    description: "Adds an estimated reading time block.",
    status: "installed",
    enabled: false,
    active: false,
    enabled_at: null,
    enabled_by: null,
    installed_at: "",
    changed_at: "",
    content_hash: "a".repeat(64),
    plugin_api: 1,
    capabilities: [],
    blocks: [],
    hooks: [],
    has_settings: false,
    ...over,
  }
}

const PLUGINS = [
  plugin({ slug: "link-checker", name: "Link checker", enabled: true, active: true, has_settings: true, capabilities: ["posts:read", "network"], blocks: ["Report"], hooks: [{ event: "post.published" }] }),
  plugin({ slug: "checklist", name: "Publish checklist", author: "Kenji Mori", capabilities: ["posts:read", "media:read"], hooks: [{ event: "post.before_publish" }] }),
  plugin({ slug: "social-cards", name: "Social cards", status: "missing", blocks: ["Card"] }),
  plugin({ slug: "old-embeds", name: "Old embeds", status: "incompatible", incompatible_reason: "plugin_api" }),
]

const SETTINGS: PluginSettings = {
  fields: [
    { name: "api_key", type: "string", secret: true, label: "API key" },
    { name: "frequency", type: "string", enum: ["daily", "weekly"], default: "daily", label: "Check links" },
    { name: "per_post", type: "number", integer: true, minimum: 1, maximum: 200, default: 50, label: "Links per post" },
    { name: "skip_own", type: "boolean", default: true, label: "Skip links to this site" },
    { name: "title", type: "string", default: "Broken links", label: "Report title" },
  ],
  values: { api_key: { set: true }, per_post: 120 },
}

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined

const click = async (label: string) => {
  const target = button(label)
  expect(target, `button ${label}`).toBeDefined()
  await act(async () => target!.click())
  await settle()
}

const dialog = () => document.querySelector("[role=dialog], [role=alertdialog]") as HTMLElement | null

function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const row = (name: string) => Array.from(container.querySelectorAll(".gl-plugin")).find((r) => r.querySelector("h2")?.textContent === name) as HTMLElement

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Plugins />
      </MemoryRouter>
    )
  )
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  for (const fn of Object.values(api)) fn.mockReset()
  api.listPlugins.mockResolvedValue({ plugins: PLUGINS, count: PLUGINS.length, plugin_api: { min: 1, max: 1 } })
  api.getPluginSettings.mockResolvedValue(SETTINGS)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("the list", () => {
  it("shows each plugin's details, status and declared capabilities", async () => {
    await render()
    const checker = row("Link checker")
    expect(checker.textContent).toContain("1.2.0")
    expect(checker.textContent).toContain("By Ana Costa")
    expect(checker.textContent).toContain("Enabled")
    expect(Array.from(checker.querySelectorAll(".gl-plugin__cap")).map((c) => c.textContent)).toEqual(["Read posts", "Connect to other services"])
    expect(row("Publish checklist").textContent).toContain("Can block publishing")
    expect(row("Social cards").textContent).toContain("Not in this build")
    expect(row("Social cards").textContent).toContain("Its blocks stay in your posts")
    expect(row("Old embeds").textContent).toContain("Incompatible")
  })

  it("offers Settings, Enable and Disable as the API allows", async () => {
    await render()
    expect(button("Settings for Link checker")).toBeDefined()
    expect(button("Disable Link checker")).toBeDefined()
    expect(button("Enable Link checker")).toBeUndefined()
    expect(button("Enable Publish checklist")).toBeDefined()
    expect(button("Settings for Publish checklist")).toBeUndefined()
    expect(row("Social cards").querySelectorAll("button").length).toBe(0)
    expect(button("Enable Old embeds (not available)")!.disabled).toBe(true)
    // No upload, delete or update: installing is shipping in the image.
    expect(container.textContent).not.toMatch(/Upload|Update to/)
  })

  it("has an empty state", async () => {
    api.listPlugins.mockResolvedValue({ plugins: [], count: 0, plugin_api: { min: 1, max: 1 } })
    await render()
    expect(container.textContent).toContain("No plugins installed")
  })

  it("shows the shared error page when the list can't load, and retries", async () => {
    api.listPlugins.mockRejectedValueOnce(new ApiError("Server error.", 500, null, null, null, "req-1234abcd"))
    await render()
    expect(container.textContent).toContain("Something went wrong")
    expect(container.textContent).toContain("req-1234abcd")
    await click("Try again")
    expect(container.textContent).toContain("Link checker")
  })
})

describe("enable and disable", () => {
  it("asks before enabling, with the trust warning and what it declares", async () => {
    await render()
    await click("Enable Publish checklist")
    expect(dialog()!.textContent).toContain("Enable Publish checklist?")
    expect(dialog()!.textContent).toContain("runs on your server with full access to your site’s data")
    expect(dialog()!.textContent).toContain("Read media")
    expect(dialog()!.textContent).toContain("Can block publishing")

    await click("Cancel")
    expect(dialog()).toBeNull()
    expect(api.enablePlugin).not.toHaveBeenCalled()

    api.enablePlugin.mockResolvedValue({ ...PLUGINS[1], enabled: true, active: true })
    await click("Enable Publish checklist")
    await click("Enable plugin")
    expect(api.enablePlugin).toHaveBeenCalledWith("checklist")
    expect(dialog()).toBeNull()
    expect(row("Publish checklist").textContent).toContain("Enabled")
    expect(button("Disable Publish checklist")).toBeDefined()
  })

  it("says what a disable affects before disabling", async () => {
    await render()
    await click("Disable Link checker")
    const text = dialog()!.textContent!
    expect(text).toContain("Disable Link checker?")
    expect(text).toContain("they still edit and still show on your site")
    expect(text).toContain("won’t be offered in the block menus")
    expect(text).toContain("Its server features stop running. Its settings are kept.")
    // The usage count waits for #456.
    expect(text).not.toMatch(/Used in/)

    api.disablePlugin.mockResolvedValue({ ...PLUGINS[0], enabled: false, active: false })
    await click("Disable plugin")
    expect(api.disablePlugin).toHaveBeenCalledWith("link-checker")
    expect(button("Enable Link checker")).toBeDefined()
  })

  it("explains a refused enable and reloads the list", async () => {
    await render()
    const error = vi.spyOn(toast, "error")
    api.enablePlugin.mockRejectedValue(new ApiError("Conflict.", 409, null, "plugin_missing"))
    await click("Enable Publish checklist")
    await click("Enable plugin")
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no longer in this build"))
    expect(api.listPlugins).toHaveBeenCalledTimes(2)
  })
})

describe("the settings panel", () => {
  async function openSettings() {
    await render()
    await click("Settings for Link checker")
    expect(api.getPluginSettings).toHaveBeenCalledWith("link-checker")
  }

  const input = (label: string) => {
    const el = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label))
    return document.getElementById(el!.htmlFor) as HTMLInputElement
  }

  it("builds the form from the manifest, never showing a saved secret", async () => {
    await openSettings()
    const panel = dialog()!
    expect(panel.textContent).toContain("Link checker settings")
    expect(input("Report title").value).toBe("Broken links")
    expect(input("Links per post").value).toBe("120")
    expect(panel.textContent).toContain("Check links")
    expect(panel.querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("true")
    expect(panel.textContent).toContain("Saved")
    expect(panel.textContent).toContain("never shown again")
    expect(button("Save settings")!.disabled).toBe(true)
  })

  it("refuses an invalid value and saves only what changed", async () => {
    await openSettings()
    type(input("Links per post"), "500")
    await click("Save settings")
    expect(dialog()!.textContent).toContain("Enter a number from 1 to 200.")
    expect(api.updatePluginSettings).not.toHaveBeenCalled()

    type(input("Links per post"), "150")
    await act(async () => (document.querySelector("[role=switch]") as HTMLButtonElement).click())
    api.updatePluginSettings.mockResolvedValue(SETTINGS)
    await click("Save settings")
    expect(api.updatePluginSettings).toHaveBeenCalledWith("link-checker", { per_post: 150, skip_own: false })
    expect(dialog()).toBeNull()
  })

  it("replaces a secret only when a new one is typed", async () => {
    await openSettings()
    await click("Replace API key")
    const key = input("API key")
    expect(key.type).toBe("password")
    expect(key.value).toBe("")
    type(key, "sk-new")
    api.updatePluginSettings.mockResolvedValue(SETTINGS)
    await click("Save settings")
    expect(api.updatePluginSettings).toHaveBeenCalledWith("link-checker", { api_key: "sk-new" })
  })

  it("deletes the plugin's data after asking", async () => {
    await openSettings()
    await click("Delete plugin data")
    const confirm = document.querySelector("[role=alertdialog]")!
    expect(confirm.textContent).toContain("Delete Link checker’s data?")
    expect(confirm.textContent).toContain("blocks in your posts aren’t touched")
    api.deletePluginData.mockResolvedValue({ deleted: 3 })
    api.getPluginSettings.mockResolvedValue({ ...SETTINGS, values: { api_key: { set: false } } })
    await click("Delete data")
    expect(api.deletePluginData).toHaveBeenCalledWith("link-checker")
    expect(document.querySelector("[role=alertdialog]")).toBeNull()
    // Reloaded: the defaults apply again and no secret is saved.
    expect(input("Links per post").value).toBe("50")
    expect(dialog()!.textContent).not.toContain("Saved")
  })
})
