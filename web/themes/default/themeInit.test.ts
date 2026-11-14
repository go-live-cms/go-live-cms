// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

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
