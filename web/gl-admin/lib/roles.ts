// Built-in user roles, lowest privilege first. Must match the API's role list
// (api/auth_roles.go and the `oneof` binding tags in api/users_bindings.go).
export const USER_ROLE_OPTIONS = [
    { value: "contributor", label: "Contributor" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Administrator" },
]

// What each role may do, in the invite dialog (#343). They restate the rules below
// and in api/auth_posts.go (#135); change them together.
export const ROLE_DESCRIPTIONS: Record<string, string> = {
    contributor: "Edits their own posts at any status; an editor publishes them. Other posts are view-only.",
    editor: "Writes, edits and publishes any post or page.",
    admin: "Everything editors can do, plus users, themes and settings.",
}

// USER_ROLE_OPTIONS with a description each, for a RadioGroup.
export function roleChoices() {
    return USER_ROLE_OPTIONS.map((r) => ({ ...r, description: ROLE_DESCRIPTIONS[r.value] }))
}

// "Administrator" for "admin"; an unknown role is shown as stored.
export function roleLabel(role?: string | null): string | undefined {
    return USER_ROLE_OPTIONS.find((r) => r.value === role?.toLowerCase())?.label ?? role ?? undefined
}

// Everything below is a UI hint only: the stored user's role can be stale after a
// demotion. The API (api/auth_roles.go, api/auth_posts.go) and the WS server (which asks
// the API) enforce the real checks against the DB.

// Roles that may edit and publish any post. Mirrors canModeratePosts /
// requireContentEditor in the API.
const CONTENT_MODERATOR_ROLES = ["admin", "editor"]

// Roles that may author content (create posts, upload media). Mirrors
// requireContentAuthor in api/auth_posts.go.
const CONTENT_AUTHOR_ROLES = [...CONTENT_MODERATOR_ROLES, "contributor"]

const hasRole = (role: string | null | undefined, roles: string[]) =>
    !!role && roles.includes(role.toLowerCase())

// Admins and editors: edit, publish and unpublish any post, see revisions.
export function isContentModerator(role?: string | null): boolean {
    return hasRole(role, CONTENT_MODERATOR_ROLES)
}

// Any content role may create posts (contributors: drafts they own) and upload
// media (#135).
export function canCreateContent(role?: string | null): boolean {
    return hasRole(role, CONTENT_AUTHOR_ROLES)
}

// Mirrors requireSiteAdmin in api/auth_roles.go (user management).
export function isSiteAdmin(role?: string | null): boolean {
    return role?.toLowerCase() === "admin"
}

export interface PermissionUser {
    id: number
    role?: string | null
}

export interface PermissionPost {
    user_id: number
    post_status?: string | null
    // The signed-in user holds an edit access grant on it (#321, GET /posts/:id/access).
    collaborator?: boolean
}

// The editor's working copy (blocks, collab socket). Mirrors canEditPost in
// api/auth_posts.go: moderators any post, contributors their own, except while it is
// scheduled (#147): the scheduler publishes the working copy as it is then, so a
// contributor's later edits would go live without an editor seeing them. Plus edit
// access grants (#321, canEditWorkingCopy): a contributor granted access to someone
// else's post edits it while it is published.
export function canEditPost(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    if (!user) return false
    // Nobody edits a post in the trash (#327): restore it first.
    if (isTrashed(post)) return false
    if (isContentModerator(user.role)) return true
    if (user.role?.toLowerCase() !== "contributor") return false
    if (post.user_id === user.id) return post.post_status?.toLowerCase() !== "scheduled"
    return !!post.collaborator && post.post_status?.toLowerCase() === "published"
}

// Editing, replacing or deleting a media file. Mirrors requireContentAuthor plus
// canWriteMedia in api/auth_roles.go: moderators any file, contributors their own.
export function canWriteMedia(user: PermissionUser | null | undefined, media: { user_id: number }): boolean {
    if (!user || !canCreateContent(user.role)) return false
    return isContentModerator(user.role) || media.user_id === user.id
}

// Live fields (title, slug, excerpt, featured image, …). Mirrors canEditPostDetails:
// a contributor may change them only while their post isn't published.
export function canEditPostDetails(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    if (!user) return false
    if (isTrashed(post)) return false
    if (isContentModerator(user.role)) return true
    return canEditPost(user, post) && post.post_status?.toLowerCase() !== "published"
}

// The trash (#327). Mirrors api/auth_posts.go: moving to the trash is the old delete
// (canEditPostDetails); restoring gives the post its old status back, so a published or
// scheduled one needs a moderator, a contributor restores their own draft (or archived
// post); permanent delete is moderators' only.
export function isTrashed(post: Pick<PermissionPost, "post_status">): boolean {
    return post.post_status?.toLowerCase() === "trash"
}

export function canTrashPost(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    return !isTrashed(post) && canEditPostDetails(user, post)
}

export function canRestorePost(
    user: PermissionUser | null | undefined,
    post: PermissionPost & { trashed_from_status?: string }
): boolean {
    if (!user || !isTrashed(post)) return false
    if (isContentModerator(user.role)) return true
    const from = post.trashed_from_status?.toLowerCase()
    return user.role?.toLowerCase() === "contributor" && post.user_id === user.id && from !== "published" && from !== "scheduled"
}

export function canDeletePostPermanently(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    return isTrashed(post) && isContentModerator(user?.role)
}

export interface PostEditorAccess {
    // The editor body is editable (otherwise it opens read-only, with no collab socket)
    content: boolean
    // Title, slug, excerpt, featured image and the other sidebar settings
    details: boolean
    // Publish / Update / Unpublish buttons and the Revisions tab
    publish: boolean
}

// What PostForm lets the signed-in user do. In create mode there is no post yet: any
// content role may write a draft, but only moderators may publish it. In edit mode it
// is the per-post rule above.
export function postEditorAccess(
    user: PermissionUser | null | undefined,
    mode: "create" | "edit",
    post?: PermissionPost
): PostEditorAccess {
    const publish = isContentModerator(user?.role)
    if (mode === "create" || !post) {
        const author = canCreateContent(user?.role)
        return { content: author, details: author, publish }
    }
    return {
        content: canEditPost(user, post),
        details: canEditPostDetails(user, post),
        publish: publish && !isTrashed(post),
    }
}
