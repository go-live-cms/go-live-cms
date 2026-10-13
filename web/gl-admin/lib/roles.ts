// Built-in user roles, lowest privilege first. Must match the API's role list
// (api/auth_roles.go and the `oneof` binding tags in api/users_bindings.go).
export const USER_ROLE_OPTIONS = [
    { value: "contributor", label: "Contributor" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Administrator" },
]
