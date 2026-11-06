import type { Post } from "@gl-admin/lib/api/types"
import type { SelectOption } from "@gl-admin/components/ui/Select"
import { isSiteAdmin, type PermissionUser } from "@gl-admin/lib/roles"

// The front page (#336): the page the site shows at /, chosen in Settings › General or
// from a page's row menu (admins only, like every setting: PUT /settings
// front_page_id). Only a published page can be chosen. If it is unpublished, archived
// or moved to the trash, / shows the latest posts until it is published again (the
// setting stays), so those actions ask first. Deleting it for good clears the setting.

// "" in the Settings select: the latest posts.
export const LATEST_POSTS = ""

export const FRONT_PAGE_BADGE = "Front page"

type PageLike = Pick<Post, "id" | "post_type">

export function isFrontPage(post: PageLike | null | undefined, frontPageId: number | null | undefined): boolean {
  return !!post && post.post_type === "page" && frontPageId != null && post.id === frontPageId
}

// "Set as front page" in the row menu: admins, on a published page that isn't it yet.
export function canSetFrontPage(user: PermissionUser | null | undefined, post: Pick<Post, "id" | "post_type" | "post_status">, frontPageId: number | null | undefined): boolean {
  return isSiteAdmin(user?.role) && post.post_type === "page" && post.post_status === "published" && !isFrontPage(post, frontPageId)
}

export function frontPageSetMessage(title: string): string {
  return `“${title || "Untitled"}” is now your front page`
}

// The actions that take the front page off the site, and so off /.
export type FrontPageAction = "unpublish" | "archive" | "trash"

export function takesFrontPageOffSite(action: string): action is FrontPageAction {
  return action === "unpublish" || action === "archive" || action === "trash"
}

const ACTION_LABEL: Record<FrontPageAction, { verb: string; done: string; confirm: string }> = {
  unpublish: { verb: "Unpublish", done: "unpublished", confirm: "Unpublish" },
  archive: { verb: "Archive", done: "archived", confirm: "Archive" },
  trash: { verb: "Move", done: "in the trash", confirm: "Move to trash" },
}

// The confirmation before one of them.
export function frontPageWarning(action: FrontPageAction, title: string): { title: string; description: string; confirm: string } {
  const name = title || "Untitled"
  const label = ACTION_LABEL[action]
  return {
    title: action === "trash" ? `Move your front page to the trash?` : `${label.verb} your front page?`,
    description: `“${name}” is the page your site shows at its home address. While it’s ${label.done}, the home page shows your latest posts instead. Publish it again to bring it back.`,
    confirm: label.confirm,
  }
}

// Settings › General's choices: the latest posts, then the published pages by title. A
// chosen page that isn't published any more stays listed, marked, so the field shows
// what is saved.
export function frontPageOptions(publishedPages: Pick<Post, "id" | "title">[], current: Pick<Post, "id" | "title" | "post_status"> | null): SelectOption[] {
  const options: SelectOption[] = [{ value: LATEST_POSTS, label: "Your latest posts" }]
  const pages = [...publishedPages].sort((a, b) => (a.title || "").localeCompare(b.title || "") || a.id - b.id)
  for (const page of pages) options.push({ value: String(page.id), label: page.title || "Untitled" })
  if (current && !pages.some((p) => p.id === current.id)) {
    options.push({ value: String(current.id), label: `${current.title || "Untitled"} (not published)`, disabled: true })
  }
  return options
}

// The hint under it: what / shows now. `current` is the chosen page (null while it is
// loading or when none is chosen).
export function frontPageHint(frontPageId: number | null, current: Pick<Post, "title" | "post_status"> | null): { text: string; warning: boolean } {
  if (frontPageId == null) return { text: "Your home page lists your latest posts.", warning: false }
  if (current && current.post_status !== "published") {
    return {
      text: `“${current.title || "Untitled"}” isn’t published, so your home page shows your latest posts until it is.`,
      warning: true,
    }
  }
  return { text: "Your home page shows this page instead of your latest posts.", warning: false }
}

export function toFrontPageValue(id: number | null | undefined): string {
  return id == null ? LATEST_POSTS : String(id)
}

export function fromFrontPageValue(value: string): number | null {
  const id = Number(value)
  return value !== LATEST_POSTS && Number.isInteger(id) && id > 0 ? id : null
}
