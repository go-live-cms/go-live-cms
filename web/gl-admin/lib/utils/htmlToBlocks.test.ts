import { describe, expect, it } from "vitest"
import { htmlToBlockDoc } from "./htmlToBlocks"

// A new post's body goes through htmlToBlockDoc on create. Its image blocks must keep
// the media id, or the public page loses srcset and the focal point and the file's
// "Used in" list misses the post (#342).
describe("htmlToBlockDoc images", () => {
  const image = (html: string) => {
    const doc = htmlToBlockDoc(html)
    return Object.values(doc.blocks).find((b) => b.type === "image")!
  }

  it("keeps data-media-id as a number", () => {
    const block = image('<p>Intro text</p><img src="/uploads/media/a.png" alt="A house" data-media-id="321">')
    expect(block.attrs).toEqual({ mediaId: 321, src: "/uploads/media/a.png", alt: "A house", title: undefined })
  })

  it("leaves it out when absent or not a number", () => {
    expect(image('<img src="/x.png">').attrs).not.toHaveProperty("mediaId")
    expect(image('<img src="/x.png" data-media-id="abc">').attrs).not.toHaveProperty("mediaId")
  })
})

describe("htmlToBlockDoc theme blocks (#376)", () => {
  it("parses an installed theme block's declared attrs by its spec, dropping the rest", () => {
    const doc = htmlToBlockDoc(
      '<div data-block-type="theme:example/alert" data-variant="warning" data-message="old" data-block-id="blk-x">Careful</div>',
    )
    const block = doc.blocks[doc.blocks_order[0]]
    expect(block).toMatchObject({ type: "theme:example/alert", version: 1, attrs: { variant: "warning", text: "Careful" } })
    expect(block.attrs).not.toHaveProperty("message")
  })

  it("leaves an invalid value out, so the default applies", () => {
    const doc = htmlToBlockDoc('<div data-block-type="theme:example/alert" data-variant="purple">x</div>')
    expect(doc.blocks[doc.blocks_order[0]].attrs).toEqual({ text: "x" })
  })
})
