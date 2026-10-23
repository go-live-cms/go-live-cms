// Guards for #305: a remote caret must never change line height. jsdom has no layout,
// so these pin the structure that caused it instead of measuring.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createCaretElement } from "./cursorAwareness"

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")

describe("createCaretElement (#305)", () => {
  const caret = createCaretElement("Ada", "#5ad1a3", 2)
  const label = caret.querySelector<HTMLElement>(".collab-caret-label")

  it("is a zero-width bordered inline span, not a sized inline-block", () => {
    expect(caret.className).toBe("collab-caret")
    expect(caret.style.display).toBe("")
    expect(caret.style.height).toBe("")
    expect(caret.style.width).toBe("")
    expect(caret.style.borderLeft).toMatch(/2px solid/)
    expect(caret.style.marginLeft).toBe("-1px")
    expect(caret.style.marginRight).toBe("-1px")
  })

  it("holds a word joiner (no width, but the line's height) before the label", () => {
    expect(caret.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(caret.firstChild?.textContent).toBe(String.fromCharCode(0x2060))
  })

  it("keeps the label out of the flow, anchored above the caret, with its own typography", () => {
    expect(label?.textContent).toBe("Ada")
    expect(label?.parentElement).toBe(caret)
    expect(label?.style.position).toBe("absolute")
    expect(label?.style.top).toBe("0px")
    expect(label?.style.transform).toBe("translateY(-100%)")
    expect(label?.style.fontStyle).toBe("normal")
    expect(label?.style.textTransform).toBe("none")
  })
})

describe("TipTap base CSS ships with the editor styles (#305)", () => {
  it("_tiptap-base.scss neutralizes ProseMirror's separator image and editor.scss uses it", () => {
    const base = read("../../../assets/styles/components/editor/_tiptap-base.scss")
    expect(base).toMatch(/img\.ProseMirror-separator\s*\{[^}]*display:\s*inline !important[^}]*margin:\s*0 !important/)
    expect(read("../../../assets/styles/components/editor/editor.scss")).toMatch(/@use "\.\/tiptap-base"/)
  })

  it("both editors turn off TipTap's injection (a destroyed editor removes the shared tag)", () => {
    for (const file of ["../Editor.tsx", "../HocuspocusEditor.tsx"]) {
      expect(read(file)).toMatch(/injectCSS:\s*false/)
    }
  })
})
