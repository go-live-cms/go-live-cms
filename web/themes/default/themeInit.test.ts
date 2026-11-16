// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "@/components/BlockRenderer"
import type { SiteRenderContext } from "@/components/blocks/utils/siteContext"

// The real scripts/theme-init.js against the header's theme toggle (#481, WCAG 4.1.2): the
// server renders "Theme" (the page is cached and can't know the reader's choice), and the
// script names the current choice once it runs and after every change.

const script = readFileSync(path.resolve("themes/default/scripts/theme-init.js"), "utf8")
const KEY = "gl-theme-preference"

function mount() {
  document.body.innerHTML = `
    <button type="button" class="icon-btn" aria-label="Theme" aria-expanded="false" aria-controls="theme-menu" data-theme-menu-toggle></button>
    <div id="theme-menu" role="group" aria-label="Theme" hidden>
      <button type="button" class="theme-choice" data-theme-choice="light" aria-pressed="false">Light</button>
      <button type="button" class="theme-choice" data-theme-choice="dark" aria-pressed="false">Dark</button>
      <button type="button" class="theme-choice" data-theme-choice="system" aria-pressed="false">System</button>
    </div>`
  // jsdom's readyState is "complete": the script sets up at once.
  new Function(script)()
}

const toggle = () => document.querySelector("[data-theme-menu-toggle]")!

beforeEach(() => {
  window.localStorage.clear()
})

describe("the theme toggle's name (#481)", () => {
  it("says the current choice: System by default", () => {
    mount()
    expect(toggle().getAttribute("aria-label")).toBe("Theme: System")
  })

  it("says the stored choice", () => {
    window.localStorage.setItem(KEY, "dark")
    mount()
    expect(toggle().getAttribute("aria-label")).toBe("Theme: Dark")
    expect(document.querySelector('[data-theme-choice="dark"]')!.getAttribute("aria-pressed")).toBe("true")
  })

  it("follows a new choice", () => {
    mount()
    document.querySelector<HTMLButtonElement>('[data-theme-choice="light"]')!.click()
    expect(toggle().getAttribute("aria-label")).toBe("Theme: Light")
  })
})

// #497: the color_scheme_switch site block has no script of its own. This same script (a plain
// <script src>, no inline code: script-src 'self' is enough) drives it, by its data-theme-choice
// buttons, beside the header's copy or without it.
describe("the colour scheme switch block (#497)", () => {
  const site = { inTemplate: true, kind: "template", site: { title: "Blog", tagline: "" }, logo: null, menusByLocation: {}, menusById: {}, parts: {} } as SiteRenderContext
  const doc = { doc_version: 1, blocks_order: ["switch-001"], blocks: { "switch-001": { id: "switch-001", type: "color_scheme_switch", version: 1, attrs: {} } } } as unknown as BlockDocV1
  const markup = renderToStaticMarkup(createElement(BlockRenderer, { doc, site }))

  it("is applied by theme-init.js: a click sets the scheme, stores it and presses that button", () => {
    expect(markup).not.toMatch(/<script|\son[a-z]+=/i)
    document.body.innerHTML = markup
    new Function(script)()
    expect(document.documentElement.hasAttribute("data-js")).toBe(true)
    expect(document.querySelector('[data-theme-choice="system"]')!.getAttribute("aria-pressed")).toBe("true")
    document.querySelector<HTMLButtonElement>('.color-scheme-switch [data-theme-choice="dark"]')!.click()
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
    expect(document.documentElement.getAttribute("data-theme-preference")).toBe("dark")
    expect(window.localStorage.getItem(KEY)).toBe("dark")
    expect(document.querySelector('[data-theme-choice="dark"]')!.getAttribute("aria-pressed")).toBe("true")
    expect(document.querySelector('[data-theme-choice="system"]')!.getAttribute("aria-pressed")).toBe("false")
  })
})