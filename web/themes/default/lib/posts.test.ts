import { describe, expect, it } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { authorNames, joinNames, readingMinutes, wordCount } from "./posts"
import { avatarColor, initial } from "./avatar"

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ")

const doc = (blocks: Record<string, unknown>) => ({ blocks, blocks_order: Object.keys(blocks) }) as unknown as BlockDocV1

describe("authorNames", () => {
  it("lists every credited author, full name first", () => {
    expect(
      authorNames({
        username: "owner",
        authors: [
          { id: 1, username: "luan", full_name: "" },
          { id: 2, username: "ana", full_name: "Ana Costa" },
        ],
      }),
    ).toEqual(["luan", "Ana Costa"])
  })

  it("falls back to the owner when the API sent no byline", () => {
    expect(authorNames({ username: "owner" })).toEqual(["owner"])
    expect(authorNames({ username: "owner", authors: [] })).toEqual(["owner"])
  })
})

describe("joinNames", () => {
  it("joins with commas and a final 'and'", () => {
    expect(joinNames([])).toBe("")
    expect(joinNames(["Ana"])).toBe("Ana")
    expect(joinNames(["Ana", "Luan"])).toBe("Ana and Luan")
    expect(joinNames(["Ana", "Luan", "Priya"])).toBe("Ana, Luan and Priya")
  })
})

describe("readingMinutes", () => {
  it("counts paragraph, nested list/quote text and code", () => {
    const d = doc({
      a: { type: "paragraph", attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "one two three" }] } } },
      b: { type: "blockquote", attrs: { pm: { content: [{ type: "paragraph", content: [{ type: "text", text: "four five" }] }] } } },
      c: { type: "code_block", attrs: { code: "const six = 7" } },
      d: { type: "list_item", attrs: { text: "eight" } },
      e: { type: "image", attrs: { src: "/x.png" } },
    })
    expect(wordCount(d)).toBe(10)
  })

  it("rounds at 220 words a minute, never below 1, null with no text", () => {
    expect(readingMinutes(doc({ a: { attrs: { text: words(50) } } }))).toBe(1)
    expect(readingMinutes(doc({ a: { attrs: { text: words(1320) } } }))).toBe(6)
    expect(readingMinutes(doc({ a: { attrs: { src: "/x.png" } } }))).toBeNull()
    expect(readingMinutes(undefined)).toBeNull()
  })
})

describe("avatar", () => {
  it("keeps an author's colour stable and takes the first letter", () => {
    expect(avatarColor(7)).toBe(avatarColor(7))
    expect(avatarColor(undefined)).toBe(avatarColor(0))
    expect(initial(" ana")).toBe("A")
    expect(initial("")).toBe("?")
  })
})
