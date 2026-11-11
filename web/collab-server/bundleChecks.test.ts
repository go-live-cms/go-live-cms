import { describe, expect, it } from "vitest"
import { clientOnlyInputs, themeBlockInputs } from "./bundleChecks.mjs"

// build.mjs fails the collab bundle on these (#376); plugin blocks are checked the same
// way as theme blocks (#452).
describe("collab bundle checks", () => {
  it("refuses a theme's or a plugin's editor.ts or render.tsx, and React", () => {
    const leaked = [
      "themes/example/blocks/Alert/editor.ts",
      "themes/example/blocks/Alert/render.tsx",
      "plugins/reading-time/blocks/estimate/editor.ts",
      "plugins/reading-time/blocks/estimate/render.tsx",
      "../web/plugins/reading-time/blocks/estimate/render.jsx",
      "node_modules/react/index.js",
      "node_modules/react-dom/client.js",
      "node_modules/@tiptap/react/dist/index.js",
    ]
    expect(clientOnlyInputs(leaked)).toEqual(leaked)
  })

  it("lets headless definitions and everything else through", () => {
    expect(
      clientOnlyInputs([
        "themes/example/blocks/Alert/index.ts",
        "plugins/reading-time/blocks/estimate/block.json",
        "gl-admin/lib/theme-blocks/editor.ts",
        "gl-admin/components/editor/extensions/BlockNodeViews.ts",
        "myplugins/x/blocks/y/editor.ts",
        "node_modules/@tiptap/core/dist/index.js",
      ]),
    ).toEqual([])
  })

  it("counts the theme blocks' index.ts files", () => {
    expect(themeBlockInputs(["themes/example/blocks/Alert/index.ts", "themes/example/blocks/Alert/editor.ts", "gl-admin/lib/index.ts"])).toEqual([
      "themes/example/blocks/Alert/index.ts",
    ])
  })
})
