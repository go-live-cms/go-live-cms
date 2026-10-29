import type { PostType } from "@gl-admin/lib/api/types"
import type { PostTypeInput } from "@gl-admin/lib/api/postTypes"

// The Post types screen (#343): the form's fields, what it sends, and which types it
// may change. The rules mirror api/post_types.go, which has the last word.

// Built in, and refused by POST and PUT /post-types (409).
export const BUILT_IN_POST_TYPES = ["post", "page"]

export function isBuiltInPostType(name: string): boolean {
  return BUILT_IN_POST_TYPES.includes(name)
}

// The `supports` values the admin and themes use. A type may carry others (a theme
// registered them); the form keeps those as they are.
export const SUPPORT_FIELDS: { value: string; label: string; note?: string }[] = [
  { value: "title", label: "Title" },
  { value: "content", label: "Content", note: "The block editor" },
  { value: "description", label: "Excerpt" },
  { value: "featured_image", label: "Featured image" },
]

// What the API stores when a create sends no `supports`.
const DEFAULT_SUPPORTS = ["title", "content", "description"]

export type PostTypeDraft = {
  label: string
  name: string
  public: boolean
  hierarchical: boolean
  has_archive: boolean
  // As typed; "" sends no menu position (the type sorts last in the sidebar).
  menu_position: string
  supports: string[]
}

export function newPostTypeDraft(): PostTypeDraft {
  // The API's defaults for a create without these fields.
  return { label: "", name: "", public: true, hierarchical: false, has_archive: true, menu_position: "", supports: [...DEFAULT_SUPPORTS] }
}

export function draftFromPostType(pt: PostType): PostTypeDraft {
  return {
    label: pt.label,
    name: pt.name,
    public: pt.public,
    hierarchical: pt.hierarchical,
    has_archive: pt.has_archive,
    // The API answers 0 for "none" (a NULL column).
    menu_position: pt.menu_position ? String(pt.menu_position) : "",
    supports: [...(pt.supports ?? [])],
  }
}

// "case_study" from "Case study": the API's identifier rule (lowercase ASCII, digits,
// '-' and '_').
export function nameFromLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50)
}

const NAME_PATTERN = /^[a-z0-9_-]+$/

// takenNames: the types already listed. POST /post-types upserts, so creating one with
// an existing name would silently overwrite it. (Inactive types aren't listed; the API
// still upserts those.)
export function validatePostTypeDraft(draft: PostTypeDraft, creating: boolean, takenNames: string[] = []): string | null {
  const label = draft.label.trim()
  if ([...label].length < 2 || [...label].length > 100) return "The label needs 2 to 100 characters."
  if (creating) {
    if (draft.name.length < 2 || draft.name.length > 50 || !NAME_PATTERN.test(draft.name)) {
      return "The name needs 2 to 50 lowercase letters, numbers, hyphens or underscores."
    }
    if (isBuiltInPostType(draft.name)) return `“${draft.name}” is built in. Choose another name.`
    if (takenNames.includes(draft.name)) {
      return `There's already a post type named “${draft.name}”. Edit it instead, or choose another name.`
    }
  }
  if (draft.menu_position !== "" && !/^\d{1,4}$/.test(draft.menu_position)) {
    return "The menu position must be a whole number from 0 to 9999."
  }
  return null
}

// The request body. PUT treats a missing boolean as false and an empty description as
// "clear it", so every field is sent, the description as it was.
export function postTypeInput(draft: PostTypeDraft, original?: PostType): PostTypeInput {
  return {
    label: draft.label.trim(),
    description: original?.description ?? "",
    public: draft.public,
    hierarchical: draft.hierarchical,
    has_archive: draft.has_archive,
    menu_position: draft.menu_position === "" ? undefined : Number(draft.menu_position),
    supports: draft.supports,
  }
}

// "3 of 4": the known fields a type has on.
export function supportsSummary(supports: string[] | null | undefined): string {
  const on = SUPPORT_FIELDS.filter((f) => supports?.includes(f.value)).length
  return `${on} of ${SUPPORT_FIELDS.length}`
}
