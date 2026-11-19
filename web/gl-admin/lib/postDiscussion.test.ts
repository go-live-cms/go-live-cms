import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { discussionSavedMessage, discussionSummary, type DiscussionInputs } from "./postDiscussion"

// The editor's Discussion section (#527): what applies now, the six panels of the
// "Discussion settings, the post's Discussion section…" board, and that its state is the
// shared rule's (discussionStateVectors.json, which the API runs too).

const NOW = new Date("2026-11-19T12:00:00Z")
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const POSTS = { label: "Posts", served: true, supports: ["title", "content", "comments"] }
const PAGES = { label: "Pages", served: true, supports: ["title", "content"] }
const base: DiscussionInputs = {
  site: { comments_enabled: true, comments_close_after_days: 30 },
  type: POSTS,
  discussion: "default",
  // First published Nov 3: closes Dec 3.
  first_published_at: "2026-11-03T09:00:00Z",
}
const summary = (over: Partial<DiscussionInputs>) => discussionSummary({ ...base, ...over }, NOW, day)

describe("the board's six panels", () => {
  it("Default with “close after 30 days”", () => {
    expect(summary({})).toEqual({
      state: "open",
      now: "Default · Open · closes on Dec 3",
      why: "Follows Posts and the site: 30 days after first publish.",
    })
  })

  it("Open on purpose ignores the timer", () => {
    expect(summary({ discussion: "open", first_published_at: "2026-01-01T00:00:00Z" })).toEqual({
      state: "open",
      now: "Open · stays open",
      why: "The site’s “close after 30 days” doesn’t apply to this post.",
    })
  })

  it("Closed", () => {
    expect(summary({ discussion: "closed" })).toMatchObject({ state: "closed", now: "Closed · shows its comments, takes no new ones" })
  })

  it("Default past the timer", () => {
    expect(summary({ first_published_at: "2026-10-04T00:00:00Z" })).toEqual({
      state: "closed",
      now: "Default · Closed on Nov 3",
      why: "Closed 30 days after first publish. Choose Open to take comments again.",
    })
  })

  it("Default on a type without comments", () => {
    expect(summary({ type: PAGES })).toEqual({
      state: "off",
      now: "Default · Off",
      why: "Pages don’t take comments. Choose Open to allow them here, or turn on Comments in Post types.",
    })
  })

  it("comments off for the site: the choice is kept", () => {
    expect(summary({ discussion: "closed", site: { comments_enabled: false, comments_close_after_days: 30 } })).toEqual({
      state: "off",
      now: "Off · comments are off for this site",
      why: "The choice is kept and applies once an admin turns comments on in Settings › Discussion.",
    })
  })
})

describe("the other cases", () => {
  it("Default without a timer", () => {
    expect(summary({ site: { comments_enabled: true, comments_close_after_days: 0 } })).toEqual({
      state: "open",
      now: "Default · Open",
      why: "Follows Posts and the site.",
    })
  })

  it("Default on a post never published yet", () => {
    expect(summary({ first_published_at: null })).toMatchObject({
      state: "open",
      now: "Default · Open",
      why: "Follows Posts and the site: closes 30 days after it’s first published.",
    })
  })

  it("one day", () => {
    expect(summary({ site: { comments_enabled: true, comments_close_after_days: 1 }, first_published_at: "2026-11-19T00:00:00Z" }).why).toBe(
      "Follows Posts and the site: 1 day after first publish."
    )
  })

  it("Off", () => {
    expect(summary({ discussion: "off" })).toMatchObject({ state: "off", now: "Off · no comments section" })
  })

  it("Open without a timer says nothing more", () => {
    expect(summary({ discussion: "open", site: { comments_enabled: true, comments_close_after_days: 0 } }).why).toBeNull()
  })

  it("a type the site doesn't serve", () => {
    expect(summary({ discussion: "open", type: { ...POSTS, label: "Notes", served: false } })).toMatchObject({
      state: "off",
      now: "Off · Notes aren’t on the site",
    })
  })
})

// The state the section shows is the shared rule's, for every vector.
const vectors = JSON.parse(readFileSync(path.resolve(__dirname, "../../src/lib/discussionStateVectors.json"), "utf8")) as {
  cases: {
    name: string
    site: { comments_enabled: boolean; comments_close_after_days: number }
    type: { public: boolean; supports: string[] }
    post: { discussion: string; first_published_at: string | null }
    now: string
    state: string
  }[]
}

describe("discussionStateVectors.json", () => {
  it.each(vectors.cases.filter((c) => ["default", "open", "closed", "off"].includes(c.post.discussion)).map((c) => [c.name, c] as const))(
    "%s",
    (_, c) => {
      const result = discussionSummary(
        {
          site: c.site,
          type: { label: "Posts", served: c.type.public, supports: c.type.supports },
          discussion: c.post.discussion as DiscussionInputs["discussion"],
          first_published_at: c.post.first_published_at,
        },
        new Date(c.now),
        day
      )
      expect(result.state).toBe(c.state)
      expect(result.now.toLowerCase()).toContain(c.state)
    }
  )
})

describe("discussionSavedMessage", () => {
  it("says it applied at once, with no Update", () => {
    expect(discussionSavedMessage("closed", true, true)).toBe("Comments closed. Readers see it within a few minutes; no Update needed.")
    expect(discussionSavedMessage("open", false, true)).toBe("Comments open. Saved; no Update needed.")
    expect(discussionSavedMessage("default", true, false)).toBe("Back to the default. It applies once comments are on for the site; no Update needed.")
    expect(discussionSavedMessage("off", true, true)).toMatch(/^Comments section hidden\./)
  })
})
