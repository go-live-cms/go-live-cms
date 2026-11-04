import { describe, expect, it } from "vitest"
import { attentionItems, describeActivity } from "./activityFeed"
import type { ActivityEvent, NeedsAttention } from "./api/activity"

// How Home's Activity lines and Needs attention items read (#324).

const now = new Date("2026-11-04T15:00:00Z")
const ana = { id: 2, username: "ana", full_name: "Ana Costa" }

const event = (overrides: Partial<ActivityEvent>): ActivityEvent => ({
  id: 1,
  verb: "published",
  object_type: "post",
  object_id: 10,
  created_at: "2026-11-04T13:00:00Z",
  actor: ana,
  post: { id: 10, title: "October changelog", post_type: "post", post_status: "published" },
  payload: {},
  ...overrides,
})

const line = (e: Partial<ActivityEvent>, viewer = 99) => {
  const d = describeActivity(event(e), viewer, now)
  return `${d.who} ${d.verb}${d.what ? ` ${d.what}` : ""}`
}

describe("describeActivity", () => {
  it("reads post events with the current title and links to the editor", () => {
    const d = describeActivity(event({}), 99, now)
    expect(d).toMatchObject({ who: "Ana Costa", actorId: 2, verb: "published", what: "October changelog", href: "/content/edit/10", when: "2 hours ago" })
    expect(line({ verb: "scheduled" })).toBe("Ana Costa scheduled October changelog")
    expect(line({ verb: "unscheduled" })).toBe("Ana Costa cancelled the schedule of October changelog")
    expect(line({ verb: "edited" })).toBe("Ana Costa edited October changelog")
    expect(line({ verb: "version_restored" })).toBe("Ana Costa restored a version of October changelog")
    expect(line({ verb: "status_changed", payload: { post_status: "archived" } })).toBe("Ana Costa archived October changelog")
    expect(line({ verb: "update_scheduled" })).toBe("Ana Costa scheduled an update to October changelog")
    expect(line({ verb: "update_unscheduled" })).toBe("Ana Costa cancelled the scheduled update of October changelog")
    expect(line({ verb: "status_changed", payload: { post_status: "draft" } })).toBe("Ana Costa set October changelog to draft")
    expect(line({ payload: { scheduled: true } })).toBe("Ana Costa published (scheduled) October changelog")
  })

  it("says You for the viewer and Someone without an actor", () => {
    expect(line({}, 2)).toBe("You published October changelog")
    expect(line({ actor: null })).toBe("Someone published October changelog")
    expect(describeActivity(event({ actor: null }), 2, now).actorId).toBeNull()
  })

  it("names a deleted post by its type, without a link", () => {
    const d = describeActivity(event({ verb: "deleted", post: undefined, payload: { post_type: "page" } }), 99, now)
    expect(`${d.verb} ${d.what}`).toBe("deleted a page")
    expect(d.href).toBeNull()
    expect(line({ verb: "deleted", post: undefined, payload: {} })).toBe("Ana Costa deleted a post")
  })

  it("reads media, invitation, member and settings events", () => {
    expect(line({ object_type: "media", verb: "uploaded", post: undefined, media: { id: 4, name: "hero.jpg" } })).toBe("Ana Costa uploaded hero.jpg")
    expect(describeActivity(event({ object_type: "media", verb: "replaced", post: undefined, media: { id: 4, name: "hero.jpg" } }), 1, now).href).toBe("/media/4")
    expect(line({ object_type: "media", verb: "deleted", post: undefined })).toBe("Ana Costa deleted a file")
    expect(line({ object_type: "invitation", verb: "invited", post: undefined, payload: { role: "contributor" } })).toBe("Ana Costa invited a contributor")
    expect(line({ object_type: "invitation", verb: "invited", post: undefined, payload: { role: "admin" } })).toBe("Ana Costa invited an administrator")
    expect(line({ object_type: "invitation", verb: "invitation_revoked", post: undefined })).toBe("Ana Costa revoked an invitation")
    const elena = { id: 5, username: "elena", full_name: "Elena V." }
    expect(line({ object_type: "user", verb: "role_changed", post: undefined, user: elena, payload: { role: "editor" } })).toBe("Ana Costa made Elena V. an editor")
    expect(line({ object_type: "user", verb: "removed", post: undefined, payload: {} })).toBe("Ana Costa removed a former member")
    expect(line({ object_type: "user", verb: "created", post: undefined, user: elena, payload: { role: "contributor" } })).toBe("Ana Costa added Elena V. as a contributor")
    expect(line({ object_type: "user", verb: "joined", post: undefined, user: ana, payload: { role: "contributor" } })).toBe("Ana Costa joined as a contributor")
    expect(line({ object_type: "settings", verb: "settings_updated", post: undefined, payload: { fields: ["site_title"] } })).toBe("Ana Costa updated the site settings")
  })

  it("passes an unknown verb through (later features add their own)", () => {
    expect(line({ verb: "review_requested" })).toBe("Ana Costa review requested October changelog")
    expect(line({ object_type: "comment", verb: "commented" })).toBe("Ana Costa commented")
  })
})

const nothing: NeedsAttention = {
  failed_schedules: { total: 0, posts: [] },
  unpublished_changes: null,
  missing_alt: null,
  review_requests: [],
}

describe("attentionItems", () => {
  it("is empty when nothing needs attention", () => {
    expect(attentionItems(nothing, now)).toEqual([])
    expect(attentionItems({ ...nothing, unpublished_changes: { total: 0, posts: [] }, missing_alt: { media_count: 0, published_post_count: 0 } }, now)).toEqual([])
  })

  it("lists failed schedules first, then alt text, then unpublished changes", () => {
    const items = attentionItems(
      {
        failed_schedules: { total: 1, posts: [{ id: 3, title: "Launch day", post_type: "post", reason: "publish_failed", attempts: 2 }] },
        missing_alt: { media_count: 3, published_post_count: 2 },
        unpublished_changes: {
          total: 1,
          posts: [{ id: 8, title: "October changelog", post_type: "post", changed_at: "2026-11-03T10:00:00Z", last_editor: ana }],
        },
        review_requests: [],
      },
      now
    )
    expect(items.map((i) => [i.title, i.detail, i.href, i.tone])).toEqual([
      ["Scheduled publish failed", "Launch day · retrying automatically", "/content/edit/3", "danger"],
      ["3 images have no alt text", "Used in 2 published posts", "/media?alt=missing", "warning"],
      ["October changelog has unpublished changes", "Edited yesterday by Ana Costa", "/content/edit/8", "accent"],
    ])
  })

  it("counts the rest beyond what it shows", () => {
    const changed = (id: number) => ({ id, title: `Post ${id}`, post_type: "post", changed_at: "2026-11-04T14:00:00Z", last_editor: null })
    const items = attentionItems(
      {
        ...nothing,
        failed_schedules: { total: 6, posts: [1, 2, 3, 4, 5].map((id) => ({ id, title: "", post_type: "post", reason: "x", attempts: 1 })) },
        unpublished_changes: { total: 7, posts: [1, 2, 3, 4, 5].map(changed) },
        missing_alt: { media_count: 1, published_post_count: 0 },
      },
      now
    )
    expect(items.filter((i) => i.tone === "danger")).toHaveLength(6)
    expect(items.find((i) => i.key === "failed-more")?.title).toBe("1 more scheduled post failed to publish")
    expect(items.find((i) => i.key === "missing-alt")).toMatchObject({ title: "1 image has no alt text", detail: "Not used in a published post yet" })
    expect(items.filter((i) => i.key.startsWith("changes-") && i.key !== "changes-more")).toHaveLength(3)
    expect(items.find((i) => i.key === "changes-more")).toMatchObject({ title: "4 more posts have unpublished changes", href: "/content/post?view=changes" })
    expect(items.find((i) => i.key === "changes-1")?.detail).toBe("Edited 1 hour ago")
    // Contributors have no Scheduled tab: the rest are under their own posts.
    const contributor = attentionItems({ ...nothing, failed_schedules: { total: 6, posts: [] } }, now, false)
    expect(contributor[0]).toMatchObject({ title: "6 more scheduled posts failed to publish", href: "/content/post?view=mine" })
  })
})
