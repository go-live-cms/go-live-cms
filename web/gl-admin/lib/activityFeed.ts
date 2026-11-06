import { editedPhrase, formatLastEdited } from "@gl-admin/lib/contentList"
import { roleLabel } from "@gl-admin/lib/roles"
import type { ActivityEvent, ActivityPerson, NeedsAttention } from "@gl-admin/lib/api/activity"

// Home's Activity feed and Needs attention (#324): how an event or an item reads.
// The API stores ids only; names and titles here are the current ones it joins.

export type ActivityLine = {
  // "Ana Costa", "You", or "Someone" (the system, or a removed member).
  who: string
  // Colour key for the avatar (the actor's id), null without an actor.
  actorId: number | null
  verb: string
  // The object: a post title, a file name, a member; "" when the verb says it all.
  what: string
  // Where the line links, null when the object is gone.
  href: string | null
  when: string
}

export function personName(person: Pick<ActivityPerson, "full_name" | "username"> | null | undefined): string {
  return (person?.full_name || person?.username || "").trim()
}

// "an editor", "a contributor".
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`
}

function role(value: unknown): string {
  return (roleLabel(typeof value === "string" ? value : undefined) ?? "member").toLowerCase()
}

function postNoun(event: ActivityEvent): string {
  const type = event.post?.post_type ?? (typeof event.payload.post_type === "string" ? event.payload.post_type : "post")
  return type === "page" ? "page" : "post"
}

const POST_VERBS: Record<string, string> = {
  created: "created",
  updated: "updated the settings of",
  edited: "edited",
  published: "published",
  unpublished: "unpublished",
  scheduled: "scheduled",
  unscheduled: "cancelled the schedule of",
  deleted: "deleted",
  version_restored: "restored a version of",
  update_scheduled: "scheduled an update to",
  update_unscheduled: "cancelled the scheduled update of",
  // Review requests (#323). review_resolved is the publish that resolved one.
  review_requested: "asked for a review of",
  review_resolved: "completed the review of",
  review_dismissed: "dismissed the review request of",
  review_changes_requested: "requested changes to",

  // Ownership (#353). The payload has ids only (no names), so the line names the post.
  transferred: "transferred",
  // Block comments (#192): ids only, never the text.
  commented: "commented on",
  comment_resolved: "resolved a comment on",
  comment_reopened: "reopened a comment on",
  comment_deleted: "deleted a comment on",
}

// Edit access (#321): "Kenji asked for edit access to X", "Ana gave Kenji edit access to
// X", "Ana declined Kenji's request for edit access to X", "Ana removed Kenji's edit
// access to X". The member it's about is `subject` (absent once removed).
function accessPart(event: ActivityEvent, title: string): { verb: string; what: string } | null {
  const subject = personName(event.subject) || "a former member"
  switch (event.verb) {
    case "access_requested":
      return { verb: "asked for edit access to", what: title }
    case "access_granted":
      return { verb: "gave", what: `${subject} edit access to ${title}` }
    case "access_declined":
      return { verb: "declined", what: `${subject}'s request for edit access to ${title}` }
    case "access_revoked":
      return { verb: "removed", what: `${subject}'s edit access to ${title}` }
  }
  return null
}

// status_changed (PUT /posts/:id): "archived X", else "set X to draft".
function statusPart(title: string, status: unknown): { verb: string; what: string } {
  if (status === "archived") return { verb: "archived", what: title }
  return typeof status === "string" && status ? { verb: "set", what: `${title} to ${status}` } : { verb: "changed the status of", what: title }
}

const MEDIA_VERBS: Record<string, string> = {
  uploaded: "uploaded",
  replaced: "replaced",
  deleted: "deleted",
}

function objectPart(event: ActivityEvent): { verb: string; what: string; href: string | null } {
  const fallbackVerb = event.verb.replace(/_/g, " ")
  switch (event.object_type) {
    case "post": {
      const href = event.post ? `/content/edit/${event.post.id}` : null
      const title = event.post ? event.post.title || "Untitled" : withArticle(postNoun(event))
      if (event.verb === "status_changed") return { ...statusPart(title, event.payload.post_status), href }
      // The trash (#327); deleting one for good is "deleted".
      if (event.verb === "trashed") return { verb: "moved", what: `${title} to the trash`, href }
      if (event.verb === "restored") return { verb: "restored", what: `${title} from the trash`, href }
      // A requester withdrawing their own request (#323).
      if (event.verb === "review_dismissed" && event.payload.withdrawn === true) return { verb: "withdrew the review request of", what: title, href }
      // Edit access (#321). The member it's about is `subject` (absent once removed).
      const access = accessPart(event, title)
      if (access) return { ...access, href }
      return { verb: POST_VERBS[event.verb] ?? fallbackVerb, what: title, href }
    }
    case "media": {
      const verb = MEDIA_VERBS[event.verb] ?? fallbackVerb
      if (!event.media) return { verb, what: "a file", href: null }
      return { verb, what: event.media.name || "a file", href: `/media/${event.media.id}` }
    }
    case "invitation":
      if (event.verb === "invited") return { verb: "invited", what: withArticle(role(event.payload.role)), href: "/users" }
      if (event.verb === "invitation_revoked") return { verb: "revoked", what: "an invitation", href: "/users" }
      return { verb: fallbackVerb, what: "an invitation", href: "/users" }
    case "user": {
      const name = personName(event.user) || "a former member"
      const href = event.user ? "/users" : null
      if (event.verb === "joined") return { verb: "joined as", what: withArticle(role(event.payload.role)), href }
      // Open signup (#191): recorded once the email is confirmed.
      if (event.verb === "signed_up") return { verb: "signed up as", what: withArticle(role(event.payload.role)), href }
      if (event.verb === "created") return { verb: "added", what: `${name} as ${withArticle(role(event.payload.role))}`, href }
      if (event.verb === "role_changed") return { verb: "made", what: `${name} ${withArticle(role(event.payload.role))}`, href }
      if (event.verb === "removed") return { verb: "removed", what: name, href: null }
      return { verb: fallbackVerb, what: name, href }
    }
    case "settings":
      return { verb: "updated", what: "the site settings", href: "/settings" }
    // #331. The feed has no title for terms and redirects, so these read generically.
    case "term": {
      if (event.verb !== "terms_merged") return { verb: fallbackVerb, what: "a term", href: null }
      const taxonomy = typeof event.payload.taxonomy === "string" ? event.payload.taxonomy : ""
      const href = taxonomy ? `/taxonomies?type=${encodeURIComponent(taxonomy)}` : "/taxonomies"
      return { verb: "merged", what: taxonomy === "tag" ? "tags" : taxonomy === "category" ? "categories" : "terms", href }
    }
    case "redirect":
      if (event.verb === "redirect_created") return { verb: "added", what: "a redirect", href: "/settings#gl-settings-urls" }
      if (event.verb === "redirect_deleted") return { verb: "deleted", what: "a redirect", href: "/settings#gl-settings-urls" }
      return { verb: fallbackVerb, what: "a redirect", href: "/settings#gl-settings-urls" }
    default:
      return { verb: fallbackVerb, what: "", href: null }
  }
}

// describeActivity turns an event into "Ana Costa published October changelog".
export function describeActivity(event: ActivityEvent, viewerId: number | null | undefined, now: Date = new Date()): ActivityLine {
  const actor = event.actor
  const who = actor ? (actor.id === viewerId ? "You" : personName(actor) || "Someone") : "Someone"
  const part = objectPart(event)
  // A post the scheduler published at its time.
  const verb = event.verb === "published" && event.payload.scheduled === true ? "published (scheduled)" : part.verb
  return { who, actorId: actor?.id ?? null, verb, what: part.what, href: part.href, when: formatLastEdited(event.created_at, now) }
}

export type AttentionTone = "danger" | "warning" | "accent" | "neutral"

export type AttentionItem = {
  key: string
  title: string
  detail: string
  href: string
  tone: AttentionTone
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// attentionItems lists Needs attention, most urgent first: failed scheduled publishes,
// then images without alt text, posts with unpublished changes, edit access requests
// (#321), review requests (#323).
// `moderator`: the list tabs differ (contributors have no Scheduled tab).
export function attentionItems(needs: NeedsAttention, now: Date = new Date(), moderator = true): AttentionItem[] {
  const items: AttentionItem[] = []

  const failed = needs.failed_schedules
  for (const post of failed.posts) {
    items.push({
      key: `failed-${post.id}`,
      title: "Scheduled publish failed",
      detail: `${post.title || "Untitled"} · retrying automatically`,
      href: `/content/edit/${post.id}`,
      tone: "danger",
    })
  }
  if (failed.total > failed.posts.length) {
    const more = failed.total - failed.posts.length
    items.push({
      key: "failed-more",
      title: `${plural(more, "more scheduled post", "more scheduled posts")} failed to publish`,
      detail: moderator ? "Open the Scheduled tab" : "Open your posts",
      href: moderator ? "/content/post?view=scheduled" : "/content/post?view=mine",
      tone: "danger",
    })
  }

  const alt = needs.missing_alt
  if (alt && alt.media_count > 0) {
    items.push({
      key: "missing-alt",
      title: `${plural(alt.media_count, "image has", "images have")} no alt text`,
      detail: alt.published_post_count > 0 ? `Used in ${plural(alt.published_post_count, "published post", "published posts")}` : "Not used in a published post yet",
      href: "/media?alt=missing",
      tone: "warning",
    })
  }

  const changes = needs.unpublished_changes
  if (changes) {
    const shown = changes.posts.slice(0, 3)
    for (const post of shown) {
      const editor = personName(post.last_editor)
      const when = editedPhrase(post.changed_at, now)
      items.push({
        key: `changes-${post.id}`,
        title: `${post.title || "Untitled"} has unpublished changes`,
        detail: editor ? `${when} by ${editor}` : when,
        href: `/content/edit/${post.id}`,
        tone: "accent",
      })
    }
    if (changes.total > shown.length) {
      const more = changes.total - shown.length
      items.push({
        key: "changes-more",
        title: `${plural(more, "more post has", "more posts have")} unpublished changes`,
        detail: "Open Changes not published",
        href: "/content/post?view=changes",
        tone: "accent",
      })
    }
  }

  // Edit access requests (#321), opened in the editor, where they're answered.
  const access = needs.access_requests ?? { total: 0, posts: [] }
  for (const request of access.posts) {
    items.push({
      key: `access-${request.request_id}`,
      title: `${personName(request.requester) || "Someone"} asked for edit access`,
      detail: request.title || "Untitled",
      href: `/content/edit/${request.id}`,
      tone: "neutral",
    })
  }
  if (access.total > access.posts.length) {
    const more = access.total - access.posts.length
    items.push({
      key: "access-more",
      title: `${plural(more, "more request", "more requests")} for edit access`,
      detail: "Open the posts to answer them",
      href: "/content/post",
      tone: "neutral",
    })
  }

  // Review requests (#323), for editors and admins: theirs first, then the longest
  // waiting. "Kenji asked for a review" · the post's title.
  const reviews = needs.review_requests
  if (reviews) {
    for (const request of reviews.posts) {
      const who = personName(request.requested_by) || "Someone"
      items.push({
        key: `review-${request.id}`,
        title: request.assigned ? `${who} asked you for a review` : `${who} asked for a review`,
        detail: request.title || "Untitled",
        href: `/content/edit/${request.post_id}`,
        tone: "neutral",
      })
    }
    if (reviews.total > reviews.posts.length) {
      const more = reviews.total - reviews.posts.length
      items.push({
        key: "review-more",
        title: `${plural(more, "more post is", "more posts are")} waiting for a review`,
        detail: "Open Review requested",
        href: "/content?review=pending",
        tone: "neutral",
      })
    }
  }
  return items
}
