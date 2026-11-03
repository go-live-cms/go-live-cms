import { describe, expect, it } from "vitest"
import { ignoresPaste, imageExtension, isTextEntryTarget, pastedFileName, pastedImages } from "./mediaPaste"

// Paste to upload (#28). jsdom has no DataTransfer, so the clipboard is a stand-in with
// the two parts pastedImages reads: `items` and `files`.

type Entry = { kind: "file"; file: File } | { kind: "string"; type: string }

function clipboard(entries: Entry[], files: File[] = []): DataTransfer {
  const items = entries.map((entry) =>
    entry.kind === "file"
      ? { kind: "file", type: entry.file.type, getAsFile: () => entry.file }
      : { kind: "string", type: entry.type, getAsFile: () => null }
  )
  return { items, files } as unknown as DataTransfer
}

const when = new Date(2026, 10, 3, 14, 5, 9) // local time
const png = (name = "image.png") => new File(["x"], name, { type: "image/png" })

describe("pastedImages", () => {
  it("keeps only images, named after the paste's time when the browser gave none", () => {
    const pdf = new File(["x"], "report.pdf", { type: "application/pdf" })
    const files = pastedImages(
      clipboard([{ kind: "string", type: "text/html" }, { kind: "file", file: png() }, { kind: "file", file: pdf }]),
      when
    )
    expect(files.map((f) => [f.name, f.type])).toEqual([["pasted-20261103-140509.png", "image/png"]])
  })

  it("takes several images, numbering the unnamed ones and keeping real names", () => {
    const jpeg = new File(["y"], "", { type: "image/jpeg" })
    const holiday = png("holiday.png")
    const files = pastedImages(
      clipboard([{ kind: "file", file: png() }, { kind: "file", file: holiday }, { kind: "file", file: jpeg }]),
      when
    )
    expect(files.map((f) => f.name)).toEqual(["pasted-20261103-140509.png", "holiday.png", "pasted-20261103-140509-2.jpg"])
    expect(files[1]).toBe(holiday) // a named file is passed through as is
  })

  it("falls back to `files` when the items have none", () => {
    const files = pastedImages(clipboard([{ kind: "string", type: "text/plain" }], [png("copied.png")]), when)
    expect(files.map((f) => f.name)).toEqual(["copied.png"])
  })

  it("is empty for text, other files or no clipboard at all", () => {
    expect(pastedImages(clipboard([{ kind: "string", type: "text/plain" }]), when)).toEqual([])
    expect(pastedImages(clipboard([], [new File(["x"], "a.txt", { type: "text/plain" })]), when)).toEqual([])
    expect(pastedImages(null, when)).toEqual([])
  })
})

describe("pasted file names", () => {
  it("stamp the local date and time, with a counter for the second and later", () => {
    expect(pastedFileName("image/png", when)).toBe("pasted-20261103-140509.png")
    expect(pastedFileName("image/webp", when, 2)).toBe("pasted-20261103-140509-3.webp")
  })

  it("take the extension from the MIME type", () => {
    expect(imageExtension("image/jpeg")).toBe("jpg")
    expect(imageExtension("image/svg+xml")).toBe("svg")
    expect(imageExtension("image/gif")).toBe("gif")
    expect(imageExtension("image/")).toBe("png")
  })
})

describe("which pastes the library leaves alone", () => {
  const el = (html: string) => {
    const host = document.createElement("div")
    host.innerHTML = html
    return host.firstElementChild!
  }

  it("text fields keep their paste", () => {
    expect(isTextEntryTarget(el(`<input type="search">`))).toBe(true)
    expect(isTextEntryTarget(el(`<input>`))).toBe(true)
    expect(isTextEntryTarget(el(`<textarea></textarea>`))).toBe(true)
    expect(isTextEntryTarget(el(`<div contenteditable="true"></div>`))).toBe(true)
    expect(isTextEntryTarget(el(`<div contenteditable="true"><p>in it</p></div>`).firstElementChild)).toBe(true)
  })

  it("the page, buttons and check boxes don't", () => {
    expect(isTextEntryTarget(el(`<button>Upload</button>`))).toBe(false)
    expect(isTextEntryTarget(el(`<input type="checkbox">`))).toBe(false)
    expect(isTextEntryTarget(el(`<div contenteditable="false"></div>`))).toBe(false)
    expect(isTextEntryTarget(document.body)).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
    expect(ignoresPaste(document.body)).toBe(false)
  })

  it("nor does anything inside a dialog", () => {
    expect(ignoresPaste(el(`<div role="dialog"><button>Delete</button></div>`).firstElementChild)).toBe(true)
  })
})
