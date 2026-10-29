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
