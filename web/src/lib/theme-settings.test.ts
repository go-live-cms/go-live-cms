import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ThemeSettingsImpl } from "./theme-settings"
import { log } from "./log"

type Row = { key: string; value: unknown; extension_type: string; extension_id: string }

/**
 * The API's /extension-settings routes as settings_handlers.go answers them: one
 * table keyed by `key` alone, PUT only for theme:<extension_id>:<name>, and a list
 * that comes back as {extension_settings, count}.
 */
function fakeApi() {
  const rows = new Map<string, Row>()

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const key = decodeURIComponent(url.pathname.split("/extension-settings/")[1] ?? "")

    if (method === "PUT") {
      const row = JSON.parse(String(init?.body)) as Row
      if (row.extension_type !== "theme" || !row.key.startsWith(`theme:${row.extension_id}:`)) {
        return json(400, { error: "key must be theme:<extension_id>:<name>" })
      }
      rows.set(row.key, row)
      return json(200, row)
    }
    if (method === "DELETE") {
      return rows.delete(key) ? json(200, { message: "deleted" }) : json(404, { error: "setting not found" })
    }
    if (key) {
      const row = rows.get(key)
      return row ? json(200, row) : json(404, { error: "setting not found" })
    }
    const id = url.searchParams.get("extension_id")
    const list = [...rows.values()].filter((row) => row.extension_type === "theme" && (!id || row.extension_id === id))
    return json(200, { extension_settings: list, count: list.length })
  })

  return { rows, fetchMock }
}

describe("ThemeSettingsImpl", () => {
  let api: ReturnType<typeof fakeApi>

  beforeEach(() => {
    api = fakeApi()
    vi.stubGlobal("fetch", api.fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("reads back what it wrote", async () => {
    const settings = new ThemeSettingsImpl("paper", "token")
    await settings.set("site_logo", "/uploads/logo.png")

    expect(await settings.get("site_logo")).toBe("/uploads/logo.png")
    expect([...api.rows.keys()]).toEqual(["theme:paper:site_logo"])
  })

  it("keeps a value's JSON shape", async () => {
    const settings = new ThemeSettingsImpl("paper", "token")
    await settings.set("header_menu", { items: [{ label: "Home", url: "/" }] })

    expect(await settings.get("header_menu")).toEqual({ items: [{ label: "Home", url: "/" }] })
  })

  it("answers null for a setting that was never stored", async () => {
    expect(await new ThemeSettingsImpl("paper").get("missing")).toBeNull()
  })

  it("deletes what it wrote", async () => {
    const settings = new ThemeSettingsImpl("paper", "token")
    await settings.set("old_setting", 1)
    await settings.delete("old_setting")

    expect(await settings.get("old_setting")).toBeNull()
    expect(api.rows.size).toBe(0)
  })

  it("getAll reads the API's response and gives back the keys it was set under", async () => {
    const settings = new ThemeSettingsImpl("paper", "token")
    await settings.set("site_logo", "/uploads/logo.png")
    await settings.set("columns", 2)

    expect(await settings.getAll()).toEqual({ site_logo: "/uploads/logo.png", columns: 2 })
  })

  it("keeps two themes with the same key apart", async () => {
    const paper = new ThemeSettingsImpl("paper", "token")
    const atlas = new ThemeSettingsImpl("atlas", "token")
    await paper.set("accent", "indigo")
    await atlas.set("accent", "amber")

    expect(await paper.get("accent")).toBe("indigo")
    expect(await atlas.get("accent")).toBe("amber")
    expect(await paper.getAll()).toEqual({ accent: "indigo" })
    expect(await atlas.getAll()).toEqual({ accent: "amber" })

    await paper.delete("accent")
    expect(await paper.get("accent")).toBeNull()
    expect(await atlas.get("accent")).toBe("amber")
  })

  it("getAll leaves out a row from before keys were namespaced", async () => {
    api.rows.set("site_logo", { key: "site_logo", value: "old", extension_type: "theme", extension_id: "paper" })
    const settings = new ThemeSettingsImpl("paper", "token")
    await settings.set("columns", 2)

    expect(await settings.getAll()).toEqual({ columns: 2 })
  })

  it("reads without a token, as the public site does", async () => {
    const admin = new ThemeSettingsImpl("paper", "token")
    await admin.set("accent", "indigo")

    const visitor = new ThemeSettingsImpl("paper")
    expect(await visitor.get("accent")).toBe("indigo")
    const headers = api.fetchMock.mock.calls.at(-1)?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it("encodes the key into the URL", async () => {
    await new ThemeSettingsImpl("paper").get("a?b")

    expect(String(api.fetchMock.mock.calls[0][0])).toContain("/extension-settings/theme%3Apaper%3Aa%3Fb")
  })

  it("logs and answers empty when the list fails", async () => {
    const warn = vi.spyOn(log, "error").mockImplementation(() => {})
    api.fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }))

    expect(await new ThemeSettingsImpl("paper").getAll()).toEqual({})
    expect(warn).toHaveBeenCalledWith("theme_setting_request_failed", expect.objectContaining({ op: "getAll" }))
  })

  it("throws when a write is refused", async () => {
    vi.spyOn(log, "error").mockImplementation(() => {})
    api.fetchMock.mockResolvedValueOnce(new Response("{}", { status: 401 }))

    await expect(new ThemeSettingsImpl("paper").set("accent", "indigo")).rejects.toThrow()
  })
})
