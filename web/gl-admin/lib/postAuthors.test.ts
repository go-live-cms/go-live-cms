import { describe, expect, it } from "vitest"
import {
  MAX_POST_AUTHORS,
  addAuthor,
  authorIds,
  authorName,
  canMoveAuthor,
  canRemoveAuthor,
  candidateOptions,
  moveAuthor,
  removeAuthor,
} from "./postAuthors"

// The Authors field's rules (#319).

const ana = { id: 1, username: "ana", full_name: "Ana Costa" }
const luan = { id: 2, username: "luan", full_name: "" }
const priya = { id: 3, username: "priya", full_name: "Priya Nair" }

describe("postAuthors", () => {
  it("names authors by full name, else username", () => {
    expect(authorName(ana)).toBe("Ana Costa")
    expect(authorName({ username: "luan", full_name: "  " })).toBe("luan")
  })

  it("adds at the end, once, up to the API's limit", () => {
    expect(addAuthor([ana], luan)).toEqual([ana, luan])
    const same = [ana, luan]
    expect(addAuthor(same, ana)).toBe(same)
    const full = Array.from({ length: MAX_POST_AUTHORS }, (_, i) => ({ id: 100 + i, username: `u${i}`, full_name: "" }))
    expect(addAuthor(full, ana)).toBe(full)
  })

  it("never removes the last author", () => {
    expect(canRemoveAuthor([ana])).toBe(false)
    expect(removeAuthor([ana], ana.id)).toEqual([ana])
    expect(removeAuthor([ana, luan, priya], luan.id)).toEqual([ana, priya])
  })

  it("moves one place, staying put at the ends", () => {
    const list = [ana, luan, priya]
    expect(moveAuthor(list, luan.id, -1)).toEqual([luan, ana, priya])
    expect(moveAuthor(list, luan.id, 1)).toEqual([ana, priya, luan])
    expect(moveAuthor(list, ana.id, -1)).toBe(list)
    expect(moveAuthor(list, priya.id, 1)).toBe(list)
    expect(moveAuthor(list, 99, 1)).toBe(list)
    expect(canMoveAuthor(list, ana.id, -1)).toBe(false)
    expect(canMoveAuthor(list, ana.id, 1)).toBe(true)
    expect(canMoveAuthor(list, priya.id, 1)).toBe(false)
    expect(authorIds(list)).toEqual([1, 2, 3])
  })

  it("offers only people not yet credited", () => {
    expect(candidateOptions([ana, luan, priya], [luan])).toEqual([
      { value: "1", label: "Ana Costa", description: "@ana" },
      { value: "3", label: "Priya Nair", description: "@priya" },
    ])
  })
})
