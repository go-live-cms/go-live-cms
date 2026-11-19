import {
  COMMENTS_SUPPORT,
  discussionSetting,
  discussionState,
  type DiscussionSite,
  type DiscussionStateName,
  type PostDiscussion,
} from "@/lib/discussion"

// The editor's Discussion section (#527, design 12.3, the "Discussion settings, the post's
// Discussion section…" board's six panels): what the post's choice means now, read with the
// shared rule (src/lib/discussion.ts, the API's twin, pinned by discussionStateVectors.json),
// and the status line after a change. Editors and admins only (decision 3).

export const DISCUSSION_CHOICES: { value: PostDiscussion; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "off", label: "Off" },
]

/** The post type as the rule reads it, with its label for the wording. */
export interface DiscussionTypeInfo {
  label: string
  // Public and active: the site serves it.
  served: boolean
  supports: readonly string[]
}

export interface DiscussionInputs {
  site: DiscussionSite
  type: DiscussionTypeInfo
  discussion: PostDiscussion
  first_published_at: string | null
}

export interface DiscussionSummary {
  state: DiscussionStateName
  // "Default · Open · closes on Dec 3"
  now: string
  // Why, when the line alone doesn't say ("Follows Posts and the site: 30 days after first publish.")
  why: string | null
}

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`)

/**
 * What applies now. `formatDay` gives a date as the site shows it ("Dec 3"), in the site's
 * time zone.
 */
export function discussionSummary(inputs: DiscussionInputs, now: Date, formatDay: (iso: string) => string): DiscussionSummary {
  const { site, type, discussion } = inputs
  const setting = discussionSetting(site, { public: type.served, supports: type.supports }, {
    discussion,
    first_published_at: inputs.first_published_at,
  })
  const state = discussionState(setting, now)
  const timer = site.comments_close_after_days

  if (!site.comments_enabled) {
    return {
      state,
      now: "Off · comments are off for this site",
      why: "The choice is kept and applies once an admin turns comments on in Settings › Discussion.",
    }
  }
  if (!type.served) return { state, now: `Off · ${type.label} aren’t on the site`, why: null }
  if (discussion === "off") return { state, now: "Off · no comments section", why: "Comments it already has are kept, and come back with another choice." }
  if (discussion === "closed") return { state, now: "Closed · shows its comments, takes no new ones", why: null }
  if (discussion === "open") {
    return {
      state,
      now: "Open · stays open",
      why: timer > 0 ? `The site’s “close after ${days(timer)}” doesn’t apply to this post.` : null,
    }
  }
  // Default: the type and the site decide.
  if (!type.supports.includes(COMMENTS_SUPPORT)) {
    return {
      state,
      now: "Default · Off",
      why: `${type.label} don’t take comments. Choose Open to allow them here, or turn on Comments in Post types.`,
    }
  }
  if (setting.closes_at) {
    return state === "closed"
      ? {
          state,
          now: `Default · Closed on ${formatDay(setting.closes_at)}`,
          why: `Closed ${days(timer)} after first publish. Choose Open to take comments again.`,
        }
      : {
          state,
          now: `Default · Open · closes on ${formatDay(setting.closes_at)}`,
          why: `Follows ${type.label} and the site: ${days(timer)} after first publish.`,
        }
  }
  return {
    state,
    now: "Default · Open",
    why: timer > 0 ? `Follows ${type.label} and the site: closes ${days(timer)} after it’s first published.` : `Follows ${type.label} and the site.`,
  }
}

/** The status line after a change: it saved at once, with no Update. */
export function discussionSavedMessage(choice: PostDiscussion, published: boolean, siteEnabled: boolean): string {
  const what = { default: "Back to the default.", open: "Comments open.", closed: "Comments closed.", off: "Comments section hidden." }[choice]
  if (!siteEnabled) return `${what} It applies once comments are on for the site; no Update needed.`
  return published ? `${what} Readers see it within a few minutes; no Update needed.` : `${what} Saved; no Update needed.`
}

export const DISCUSSION_SAVE_FAILED = "Couldn’t save the change. Try again."
