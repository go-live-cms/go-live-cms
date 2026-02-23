/**
 * Example Theme Configuration
 * Demonstrates Phase 1 asset registration
 */

export interface ThemeConfig {
  name: string
  description: string
  version: string
  author: string
  thumbnail?: string
  screenshots?: string[]
  layouts: {
    post: {
      default: string
      variants: string[]
    }
    page: {
      default: string
      variants: string[]
    }
  }
  assets: {
    styles: Array<{ src: string; media?: string }>
    scripts?: Array<{ src: string; defer?: boolean; async?: boolean; type?: string }>
  }
  blocks?: Array<{
    type: string
    modulePath: string // Path to the block module
  }>
  postTypes?: Array<{
    name: string
    label: string
    description?: string
    icon?: string
    hierarchical?: boolean
    hasArchive?: boolean
    menuPosition?: number
    supports?: string[]
  }>
}

export const themeConfig: ThemeConfig = {
  name: "Example Theme",
  description: "Full-featured example demonstrating Phase 2 theme functions",
  version: "1.0.0",
  author: "Go Live CMS",
  thumbnail: "/themes/example/thumbnail.jpg",
  screenshots: ["/themes/example/screenshot-1.jpg"],
  layouts: {
    post: {
      default: "default",
      variants: ["default", "sidebar"],
    },
    page: {
      default: "default",
      variants: ["default", "fullwidth"],
    },
  },
  assets: {
    styles: [{ src: "/themes/example/styles/theme.css", media: "all" }],
    scripts: [{ src: "/themes/example/scripts/theme.js", defer: true }],
  },
  blocks: [
    {
      type: "alert",
      modulePath: "/themes/example/blocks/Alert/index.ts",
    },
  ],
  postTypes: [
    {
      name: "product",
      label: "Products",
      description: "Product listings for the store",
      icon: "shopping-bag",
      hierarchical: false,
      hasArchive: true,
      menuPosition: 5,
      supports: ["title", "content", "description", "featured_image"],
    },
  ],
}
