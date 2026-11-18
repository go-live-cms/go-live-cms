import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import {
  discussionSetting,
  discussionState,
  normalizeReaderCommentBody,
  normalizeReaderCommentName,
  READER_COMMENT_LIMITS,
  readerCommentLength,
  type DiscussionPost,
  type DiscussionSetting,
  type DiscussionSite,
  type DiscussionType,
} from "./discussion"

// The vectors api/discussion_test.go runs too (#522). JSON.parse, not a JSON import, as
// the other shared vectors are read.
function readVectors<T>(name: string): T {
  return JSON.parse(readFileSync(path.resolve(__dirname, name), "utf8"))
}

interface StateCase {
  name: string
  site: DiscussionSite
  type: DiscussionType
  post: DiscussionPost
  now: string
  setting: DiscussionSetting
  state: string
}

const stateVectors = readVectors<{ cases: StateCase[] }>("discussionStateVectors.json")

const instant = (value: string | null) => (value === null ? null : Date.parse(value))

describe("discussionStateVectors.json", () => {
  it("has cases", () => {
    expect(stateVectors.cases.length).toBeGreaterThan(10)
  })

  it.each(stateVectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const setting = discussionSetting(c.site, c.type, c.post)
    expect(setting.state).toBe(c.setting.state)
    expect(instant(setting.closes_at)).toBe(instant(c.setting.closes_at))
    expect(discussionState(setting, new Date(c.now))).toBe(c.state)
  })

  it("includes an explicit Open overriding the timer", () => {
    const c = stateVectors.cases.find((v) => v.post.discussion === "open" && v.site.comments_close_after_days > 0)
    expect(c?.state).toBe("open")
  })
})

interface Repeat {
  text: string
  times: number
}

interface TextCase {
  name: string
  input?: string
  repeat?: Repeat
  normalized?: string
  normalized_repeat?: Repeat
  code?: string
}

const textVectors = readVectors<{ limits: Record<string, number>; body: TextCase[]; name: TextCase[] }>(
  "discussionTextVectors.json",
)

const expand = (value: string | undefined, repeat: Repeat | undefined) => (repeat ? repeat.text.repeat(repeat.times) : value ?? "")

describe("discussionTextVectors.json", () => {
  it("pins the limits the form's counter uses", () => {
    expect(textVectors.limits).toEqual({ ...READER_COMMENT_LIMITS })
  })

  for (const [kind, normalize] of [
    ["body", normalizeReaderCommentBody],
    ["name", normalizeReaderCommentName],
  ] as const) {
    it.each(textVectors[kind].map((c) => [c.name, c] as const))(`${kind}: %s`, (_name, c) => {
      const result = normalize(expand(c.input, c.repeat))
      if (c.code) {
        expect(result).toEqual({ ok: false, code: c.code })
      } else {
        expect(result).toEqual({ ok: true, text: expand(c.normalized, c.normalized_repeat) })
      }
    })
  }

  it("counts code points, as the API does", () => {
    expect(readerCommentLength("😀😀")).toBe(2)
    expect("😀😀".length).toBe(4)
  })
})
