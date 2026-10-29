import type { Settings } from "@gl-admin/lib/api/settings"

// The General settings form (#343): what the page edits, which fields differ from the
// saved settings, and what the unsaved-changes bar says about them.

export type SettingsDraft = Pick<Settings, "site_title" | "posts_per_page" | "post_url_structure">

const FIELDS: { key: keyof SettingsDraft; label: string }[] = [
  { key: "site_title", label: "site title" },
  { key: "posts_per_page", label: "posts per page" },
  { key: "post_url_structure", label: "post URL structure" },
]

// The API's bounds (binding tags on the settings request).
export const POSTS_PER_PAGE_MIN = 1
export const POSTS_PER_PAGE_MAX = 100
export const SITE_TITLE_MAX = 200

export function toDraft(settings: Settings): SettingsDraft {
  return {
    site_title: settings.site_title,
    posts_per_page: settings.posts_per_page,
    post_url_structure: settings.post_url_structure,
  }
}

// Labels of the fields that differ, in form order.
export function changedFields(saved: SettingsDraft | null, draft: SettingsDraft): string[] {
  if (!saved) return []
  return FIELDS.filter(({ key }) => saved[key] !== draft[key]).map(({ label }) => label)
}

// "You changed the site title", "… the site title and posts per page", "… 3 settings".
export function unsavedMessage(changed: string[]): string {
  if (changed.length === 0) return ""
  if (changed.length === 1) return `You changed the ${changed[0]}`
  if (changed.length === 2) return `You changed the ${changed[0]} and ${changed[1]}`
  return `You changed ${changed.length} settings`
}

// A message naming the fix, or null. posts_per_page is NaN while the field is empty.
export function validateDraft(draft: SettingsDraft): string | null {
  if (!draft.site_title) return "Enter a site title."
  if ([...draft.site_title].length > SITE_TITLE_MAX) return `The site title can be at most ${SITE_TITLE_MAX} characters.`
  const n = draft.posts_per_page
  if (!Number.isInteger(n) || n < POSTS_PER_PAGE_MIN || n > POSTS_PER_PAGE_MAX) {
    return `Posts per page must be a whole number from ${POSTS_PER_PAGE_MIN} to ${POSTS_PER_PAGE_MAX}.`
  }
  return null
}
