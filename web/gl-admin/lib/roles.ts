// Built-in user roles, lowest privilege first. Must match the API's role list
// (api/auth_roles.go and the `oneof` binding tags in api/users_bindings.go).
export const USER_ROLE_OPTIONS = [
    { value: "contributor", label: "Contributor" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Administrator" },
]

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
}

// The editor's working copy (blocks, collab socket). Mirrors canEditPost in
// api/auth_posts.go: moderators any post, contributors their own.
export function canEditPost(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    if (!user) return false
    if (isContentModerator(user.role)) return true
    return user.role?.toLowerCase() === "contributor" && post.user_id === user.id
}

// Live fields (title, slug, excerpt, featured image, …). Mirrors canEditPostDetails:
// a contributor may change them only while their post isn't published.
export function canEditPostDetails(user: PermissionUser | null | undefined, post: PermissionPost): boolean {
    if (!user) return false
    if (isContentModerator(user.role)) return true
    return canEditPost(user, post) && post.post_status?.toLowerCase() !== "published"
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
        publish,
    }
}
