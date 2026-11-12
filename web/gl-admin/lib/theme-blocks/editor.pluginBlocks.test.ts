import { describe, expect, it } from "vitest"
import { defineThemeBlock } from "./define"
import { themeBlockEditor } from "./editor"
import { getEnabledPlugins, menuEntries, setEnabledPlugins } from "../../components/editor/blocks/catalog"

// A plugin block's catalog entry (#452): it names its plugin, never a theme, so it isn't
// tied to the active theme the way a theme block's entry is. It is offered while its plugin
// is enabled (#456, design 4.3).

const definition = defineThemeBlock({
  type: "plugin:reading-time/estimate",
  version: 1,
  title: "Reading time",
  content: "",
  attrs: {},
})
const { entry } = themeBlockEditor(definition, { nodeView: () => null, icon: "⏱" })

describe("a plugin block's catalog entry", () => {
  it("names its plugin and no theme", () => {
    expect(entry).toMatchObject({ id: definition.type, type: definition.type, name: "Reading time", plugin: "reading-time" })
    expect(entry.theme).toBeUndefined()
  })

  it("is offered whichever theme is active, while its plugin is enabled", () => {
    const plugins = new Set(["reading-time"])
    for (const theme of ["default", "example", null]) {
      expect(menuEntries({ role: "editor", theme, plugins }, [entry]), String(theme)).toEqual([entry])
    }
  })

  it("is not offered while its plugin is disabled, or before the enabled list was read", () => {
    expect(menuEntries({ role: "admin", plugins: new Set() }, [entry])).toEqual([])
    expect(menuEntries({ role: "admin", plugins: new Set(["other"]) }, [entry])).toEqual([])
  })

  it("follows the list ThemeProvider last read, which starts empty", () => {
    const before = getEnabledPlugins()
    try {
      setEnabledPlugins([])
      expect(menuEntries({ role: "editor" }, [entry])).toEqual([])
      setEnabledPlugins(["reading-time"])
      expect(menuEntries({ role: "editor" }, [entry])).toEqual([entry])
      // A new Set each time, so the slash menu's cache (extensions.ts) sees the change.
      const first = getEnabledPlugins()
      setEnabledPlugins(["reading-time"])
      expect(getEnabledPlugins()).not.toBe(first)
    } finally {
      setEnabledPlugins(before)
    }
  })

  it("core and theme entries don't depend on the enabled list", () => {
    const core = { ...entry, id: "paragraph", type: "paragraph", plugin: undefined }
    expect(menuEntries({ role: "editor", plugins: new Set() }, [core])).toEqual([core])
  })
})
