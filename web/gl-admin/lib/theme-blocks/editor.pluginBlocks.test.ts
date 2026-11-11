import { describe, expect, it } from "vitest"
import { defineThemeBlock } from "./define"
import { themeBlockEditor } from "./editor"
import { menuEntries } from "../../components/editor/blocks/catalog"

// A plugin block's catalog entry (#452): it names its plugin, never a theme, so it isn't
// tied to the active theme the way a theme block's entry is.

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

  it("is offered whichever theme is active", () => {
    for (const theme of ["default", "example", null]) {
      expect(menuEntries({ role: "editor", theme }, [entry]), String(theme)).toEqual([entry])
    }
  })
})
