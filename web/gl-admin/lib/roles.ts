// Built-in user roles, lowest privilege first. Must match the API's role list
// (api/auth_roles.go and the `oneof` binding tags in api/users_bindings.go).
export const USER_ROLE_OPTIONS = [
    { value: "contributor", label: "Contributor" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Administrator" },
]

// Roles allowed to edit post content. Mirrors requireContentEditor in
// api/auth_roles.go (and websocket/access.js), which is the source of truth.
const CONTENT_EDITOR_ROLES = ["admin", "editor"]

// UI hint only: the stored user's role can be stale after a demotion. The API and
// the WS server enforce the real check against the DB.
export function canEditContent(role?: string | null): boolean {
    if (!role) return false
    return CONTENT_EDITOR_ROLES.includes(role.toLowerCase())
}
