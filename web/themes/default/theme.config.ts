/**
 * Default Theme Configuration
 *
 * This is the base theme for Go Live CMS
 */

export interface ThemeColors {
  primary: string
  secondary: string
  background: string
  surface: string
  text: string
  textMuted: string
  border: string
  accent: string
}

export interface ThemeTypography {
  fontFamily: {
    base: string
    heading: string
    mono: string
  }
  fontSize: {
    xs: string
    sm: string
    base: string
    lg: string
    xl: string
    "2xl": string
    "3xl": string
    "4xl": string
  }
}

export interface ThemeLayout {
  container: string
  gutter: string
}

export interface LayoutVariant {
  file: string
  label: string
  description?: string
  preview?: string
}

export interface ThemeConfig {
  name: string
  description: string
  version: string
  author: string
  license: string
  parent?: string

  supports: {
    postTypes: string[]
    customBlocks: boolean
    darkMode: boolean
    childThemes: boolean
  }

  colors: {
    light: ThemeColors
    dark: ThemeColors
  }

  typography: ThemeTypography

  layout: ThemeLayout

  layouts: {
    post: Record<string, LayoutVariant>
    page: Record<string, LayoutVariant>
  }

  darkMode: {
    strategy: "class" | "media"
    attribute: string
    defaultMode: "light" | "dark" | "system"
    storageKey: string
  }
}

export const themeConfig: ThemeConfig = {
  name: "Default Theme",
  description: "The default theme for Go Live CMS",
  version: "1.0.0",
  author: "Go Live CMS",
  license: "MIT",

  supports: {
    postTypes: ["post", "page"],
    customBlocks: true,
    darkMode: true,
    childThemes: true,
  },

  colors: {
    light: {
      primary: "59 130 246", // blue-500
      secondary: "100 116 139", // slate-500
      background: "255 255 255", // white
      surface: "248 250 252", // slate-50
      text: "15 23 42", // slate-900
      textMuted: "100 116 139", // slate-500
      border: "226 232 240", // slate-200
      accent: "168 85 247", // purple-500
    },
    dark: {
      primary: "96 165 250", // blue-400 (lighter for dark bg)
      secondary: "148 163 184", // slate-400
      background: "15 23 42", // slate-900
      surface: "30 41 59", // slate-800
      text: "241 245 249", // slate-100
      textMuted: "148 163 184", // slate-400
      border: "51 65 85", // slate-700
      accent: "192 132 252", // purple-400
    },
  },

  typography: {
    fontFamily: {
      base: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      heading: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      mono: '"Courier New", Courier, monospace',
    },
    fontSize: {
      xs: "0.75rem", // 12px
      sm: "0.875rem", // 14px
      base: "1rem", // 16px
      lg: "1.125rem", // 18px
      xl: "1.25rem", // 20px
      "2xl": "1.5rem", // 24px
      "3xl": "1.875rem", // 30px
      "4xl": "2.25rem", // 36px
    },
  },

  layout: {
    container: "1200px",
    gutter: "2rem",
  },

  layouts: {
    post: {
      default: {
        file: "layouts/post/default.astro",
        label: "Default Post Layout",
        description: "Clean, centered layout for blog posts",
      },
      sidebar: {
        file: "layouts/post/sidebar.astro",
        label: "Post with Sidebar",
        description: "Two-column layout with sidebar",
      },
      wide: {
        file: "layouts/post/wide.astro",
        label: "Wide Layout",
        description: "Full-width content layout",
      },
    },
    page: {
      default: {
        file: "layouts/page/default.astro",
        label: "Default Page",
        description: "Standard page layout",
      },
      fullwidth: {
        file: "layouts/page/fullwidth.astro",
        label: "Full Width Page",
        description: "Edge-to-edge full width layout",
      },
    },
  },

  darkMode: {
    strategy: "class",
    attribute: "data-theme",
    defaultMode: "system",
    storageKey: "gl-theme-preference",
  },
}

export default themeConfig
