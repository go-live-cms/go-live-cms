/**
 * Default Theme Configuration
 *
 * The base theme for Go Live CMS (#345). The token values come from the "GoLive
 * Default Theme" design canvas (Foundations board). base.astro turns them into CSS
 * custom properties (tokens.ts), so styles/theme.css only uses var(--...).
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
  // Added with #345; optional so older themes that reuse this interface still type-check.
  primaryHover?: string
  onPrimary?: string
  primarySubtle?: string
  surface2?: string
  borderStrong?: string
  highlight?: string
  focus?: string
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
  lineHeight?: {
    tight: number
    snug: number
    normal: number
    relaxed: number
  }
}

export interface ThemeLayout {
  container: string
  gutter: string
  // The reading measure, and the width wide images, code and the wide post layout use.
  contentWidth?: string
  wideWidth?: string
  headerHeight?: string
}

export interface LayoutVariant {
  file: string
  label: string
  description?: string
  preview?: string
}

export interface ThemeAsset {
  src: string
  media?: string
  defer?: boolean
  async?: boolean
  type?: string
}

export interface ThemeAssets {
  styles?: ThemeAsset[]
  scripts?: ThemeAsset[]
}

export interface ThemeConfig {
  name: string
  description: string
  version: string
  author: string
  license: string
  parent?: string

  // WordPress-style asset registration (wp_enqueue_style/script equivalent)
  assets?: ThemeAssets

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

  // Spacing scale (space-1 … space-10) and corner radii.
  spacing?: Record<string, string>
  radius?: Record<string, string>

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
  version: "2.0.0",
  author: "Go Live CMS",
  license: "MIT",

  assets: {
    styles: [
      {
        src: "/themes/default/styles/theme.css",
        media: "all",
      },
    ],
  },

  supports: {
    postTypes: ["post", "page"],
    customBlocks: true,
    darkMode: true,
    childThemes: true,
  },

  // Primary is a step between Radix Jade 11 and 12 so links pass 4.5:1 on background and
  // surface; neutrals are Radix Sand. Accent never carries text (quote mark only).
  // Contrast is checked by tokens.test.ts.
  colors: {
    light: {
      primary: "#1b7760",
      secondary: "#1d3b31",
      background: "#fdfdfc",
      surface: "#f9f9f8",
      text: "#21201c",
      textMuted: "#63635e",
      border: "#dad9d6",
      accent: "#ffc53d",
      primaryHover: "#145a48",
      onPrimary: "#ffffff",
      primarySubtle: "#e6f7ed",
      surface2: "#f1f0ef",
      borderStrong: "#8d8d86",
      highlight: "#ffe7b3",
      focus: "#1b7760",
    },
    dark: {
      primary: "#1fd8a4",
      secondary: "#adf0d4",
      background: "#111110",
      surface: "#191918",
      text: "#eeeeec",
      textMuted: "#b5b3ad",
      border: "#3b3a37",
      accent: "#ffc53d",
      primaryHover: "#63e3bd",
      onPrimary: "#111110",
      primarySubtle: "#0f2e22",
      surface2: "#222221",
      borderStrong: "#6f6d66",
      highlight: "#4a3a10",
      focus: "#1fd8a4",
    },
  },

  // The fonts are self-hosted (fonts/, @font-face in styles/theme.css).
  typography: {
    fontFamily: {
      base: '"Literata", Georgia, "Times New Roman", serif',
      heading: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
      mono: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    },
    // xs and sm are fixed; base and up scale from 375px to 1280px.
    fontSize: {
      xs: "0.8125rem", // 13px
      sm: "0.9375rem", // 15px
      base: "clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)", // 17 → 19px
      lg: "clamp(1.1875rem, 1.1rem + 0.35vw, 1.375rem)", // 19 → 22px
      xl: "clamp(1.375rem, 1.25rem + 0.5vw, 1.625rem)", // 22 → 26px
      "2xl": "clamp(1.625rem, 1.4rem + 0.9vw, 2rem)", // 26 → 32px
      "3xl": "clamp(1.875rem, 1.5rem + 1.6vw, 2.5rem)", // 30 → 40px
      "4xl": "clamp(2.25rem, 1.6rem + 2.6vw, 3.25rem)", // 36 → 52px
    },
    lineHeight: {
      tight: 1.15, // display titles
      snug: 1.3, // headings
      normal: 1.5, // interface text
      relaxed: 1.7, // body copy
    },
  },

  layout: {
    container: "1200px",
    gutter: "clamp(20px, 4vw, 40px)",
    contentWidth: "680px",
    wideWidth: "960px",
    headerHeight: "64px",
  },

  spacing: {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "24px",
    "6": "32px",
    "7": "48px",
    "8": "64px",
    "9": "96px",
    "10": "128px",
  },

  radius: {
    sm: "4px",
    md: "8px",
    lg: "14px",
    full: "999px",
  },

  layouts: {
    post: {
      default: {
        file: "layouts/post/default.astro",
        label: "Default",
        description: "One reading column with the featured image at wide width",
      },
      sidebar: {
        file: "layouts/post/sidebar.astro",
        label: "Sidebar",
        description: "Reading column with a sidebar beside it",
      },
      wide: {
        file: "layouts/post/wide.astro",
        label: "Wide",
        description: "Centred title, full-bleed featured image, wide images and code",
      },
    },
    page: {
      default: {
        file: "layouts/page/default.astro",
        label: "Default",
        description: "One reading column",
      },
      fullwidth: {
        file: "layouts/page/fullwidth.astro",
        label: "Full width",
        description: "A title band across the page; content can run edge to edge",
      },
    },
  },

  // The header's Light / Dark / System switch stores the choice under storageKey
  // (scripts/theme-init.js); "system" follows prefers-color-scheme.
  darkMode: {
    strategy: "class",
    attribute: "data-theme",
    defaultMode: "system",
    storageKey: "gl-theme-preference",
  },
}

export default themeConfig
