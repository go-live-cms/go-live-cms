import { describe, expect, it } from "vitest"
import { contentTokens, diffText, diffTokens, hasChanges, tokenize, type Segment } from "./wordDiff"

// History's word diff (#355): tokens, Myers, the whitespace join and the edit cap.

const show = (segments: Segment[]) =>
  segments.map((s) => (s.op === "same" ? s.text : s.op === "version" ? `[+${s.text}]` : `[-${s.text}]`)).join("")

describe("tokenize", () => {
  it("splits words, whitespace and punctuation, keeping hyphenated words and apostrophes whole", () => {
    expect(tokenize("Real-time, isn't it?").map((t) => t.text)).toEqual([
      "Real-time",
      ",",
      " ",
      "isn't",
      " ",
      "it",
      "?",
    ])
  })

  it("splits CJK text per character (no spaces between words there)", () => {
    expect(tokenize("日本語").map((t) => t.text)).toEqual(["日", "本", "語"])
  })

  it("keys tokens by text and marks", () => {
    const [plain] = tokenize("word")
    const [bold] = tokenize("word", [{ type: "bold" }])
    expect(plain.key).not.toBe(bold.key)
    // Mark order doesn't matter.
    expect(tokenize("w", [{ type: "bold" }, { type: "italic" }])[0].key).toBe(
      tokenize("w", [{ type: "italic" }, { type: "bold" }])[0].key
    )
  })
})

describe("diffTokens", () => {
  it("finds an inserted word, the version's run first", () => {
    expect(show(diffText("syncs every keystroke", "syncs every single keystroke"))).toBe(
      "syncs every [+single ]keystroke"
    )
  })

  it("finds a removed word", () => {
    expect(show(diffText("Shipping real-time collaboration in GoLive", "Shipping real-time collaboration"))).toBe(
      "Shipping real-time collaboration[- in GoLive]"
    )
  })

  it("joins changes separated only by whitespace into one replaced phrase", () => {
    expect(show(diffText("the quick fox", "a slow fox"))).toBe("[+a slow][-the quick] fox")
  })

  it("reports identical text as one unchanged run", () => {
    const segments = diffText("Same words here.", "Same words here.")
    expect(segments).toEqual([{ op: "same", text: "Same words here." }])
    expect(hasChanges(segments)).toBe(false)
  })

  it("handles one side empty", () => {
    expect(show(diffText("", "new text"))).toBe("[+new text]")
    expect(show(diffText("old text", ""))).toBe("[-old text]")
    expect(diffText("", "")).toEqual([])
  })

  it("counts a mark change as a change", () => {
    const working = tokenize("make it bold")
    const version = [...tokenize("make it "), ...tokenize("bold", [{ type: "bold" }])]
    const segments = diffTokens(working, version)
    expect(segments).toContainEqual({ op: "version", text: "bold", marks: [{ type: "bold" }] })
    expect(segments).toContainEqual({ op: "working", text: "bold" })
  })

  it("shows text rewritten beyond the edit cap as all removed and all added", () => {
    const w = tokenize("a b c d e f")
    const v = tokenize("u v w x y z")
    const segments = diffTokens(w, v, 2)
    expect(segments.map((s) => s.op)).toEqual(["version", "working"])
    expect(segments[0].text).toBe("u v w x y z")
  })

  it("matches the minimal edit script on interleaved changes", () => {
    expect(show(diffText("one two three four five", "one 2 three four 5"))).toBe(
      "one [+2][-two] three four [+5][-five]"
    )
  })
})

describe("contentTokens", () => {
  it("turns hard breaks and nested paragraphs into break and paragraph tokens", () => {
    const tokens = contentTokens([
      {
        type: "paragraph",
        content: [{ type: "text", text: "First" }, { type: "hardBreak" }, { type: "text", text: "line" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      { type: "paragraph" },
    ])
    expect(tokens.map((t) => t.kind ?? t.text)).toEqual(["First", "break", "line", "para", "Second"])
  })
})
