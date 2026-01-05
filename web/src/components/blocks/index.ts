// Block Spec v1 Component Architecture
// WordPress-style modular block rendering system with auto-discovery

export * from "./types"
export * from "./utils/contentRenderer"
export { blockRegistry, default as registry } from "./registry"
