// Block Spec v1 Component Architecture
// WordPress-style modular block rendering system

export * from "./types"
export * from "./utils/contentRenderer"
export { blockRegistry, default as registry } from "./registry"

// Re-export all block components for direct access if needed
export * from "./components"
