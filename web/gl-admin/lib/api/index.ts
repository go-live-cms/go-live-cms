// Re-export all API modules for easy importing
export * from "./types"
export * from "./media"
export * from "./posts"
export * from "./users"
export * from "./sessions"
export * from "./taxonomies"
export * from "./postTypes"
export * from "./utils"

// Import and re-export the legacy API object for backward compatibility
export { default as legacyApi } from "../api"
export { apiCall } from "../api"
