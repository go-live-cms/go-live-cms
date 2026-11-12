import { afterEach, describe, expect, it, vi } from "vitest"
import { enabledPluginSlugs, refreshEnabledPlugins, watchEnabledPlugins } from "./enabledPlugins"
import { getEnabledPlugins, setEnabledPlugins } from "../components/editor/blocks/catalog"

// #456 (design 4.3): the block menus offer an enabled plugin's blocks only, from
// GET /plugins/enabled, read on load and when the tab becomes visible. A failed read offers none.

afterEach(() => {
  setEnabledPlugins([])
})

describe("enabledPluginSlugs", () => {
  it("reads the API's answer, and refuses anything else", () => {
    expect(enabledPluginSlugs({ plugins: ["reading-time"] })).toEqual(["reading-time"])
    expect(enabledPluginSlugs({ plugins: [] })).toEqual([])
    expect(enabledPluginSlugs({ plugins: [1] })).toBeNull()
    expect(enabledPluginSlugs({})).toBeNull()
    expect(enabledPluginSlugs(null)).toBeNull()
  })
})

describe("refreshEnabledPlugins", () => {
  it("hands the list to the block menus", async () => {
    await refreshEnabledPlugins(async () => ({ plugins: ["reading-time"] }))
    expect([...getEnabledPlugins()]).toEqual(["reading-time"])
  })

  it("a failed or malformed read offers none", async () => {
    setEnabledPlugins(["reading-time"])
    await refreshEnabledPlugins(async () => {
      throw new Error("offline")
    })
    expect([...getEnabledPlugins()]).toEqual([])
    setEnabledPlugins(["reading-time"])
    await refreshEnabledPlugins(async () => ({ plugins: "reading-time" }))
    expect([...getEnabledPlugins()]).toEqual([])
  })

  it("a slow answer never replaces a later one", async () => {
    let answerFirst: (value: unknown) => void = () => {}
    const first = refreshEnabledPlugins(() => new Promise((resolve) => (answerFirst = resolve)))
    await refreshEnabledPlugins(async () => ({ plugins: ["new"] }))
    answerFirst({ plugins: ["old"] })
    await first
    expect([...getEnabledPlugins()]).toEqual(["new"])
  })
})

describe("watchEnabledPlugins", () => {
  it("reads at once and whenever the tab becomes visible, until stopped", async () => {
    const fetcher = vi.fn(async () => ({ plugins: ["reading-time"] }))
    let visibility: DocumentVisibilityState = "visible"
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
    const stop = watchEnabledPlugins(fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)

    visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(fetcher).toHaveBeenCalledTimes(1)
    visibility = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(fetcher).toHaveBeenCalledTimes(2)

    stop()
    document.dispatchEvent(new Event("visibilitychange"))
    expect(fetcher).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    expect([...getEnabledPlugins()]).toEqual(["reading-time"])
  })
})
