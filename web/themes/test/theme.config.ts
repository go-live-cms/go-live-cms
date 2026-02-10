/**
 * Magazine Theme Configuration
 *
 * A bold, vibrant theme with modern typography and colorful design
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
  name: "Magazine Theme",
  description: "Bold, vibrant magazine-style theme with modern typography",
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
      primary: "239 68 68", // red-500 - Bold magazine red
      secondary: "251 146 60", // orange-400 - Vibrant accent
      background: "250 250 249", // stone-50 - Warm white
      surface: "255 255 255", // Pure white
      text: "28 25 23", // stone-900 - Deep black
      textMuted: "120 113 108", // stone-500 - Muted text
      border: "245 158 11", // amber-500 - Bold borders
      accent: "16 185 129", // emerald-500 - Fresh green
    },
    dark: {
      primary: "248 113 113", // red-400 - Lighter red for dark
      secondary: "251 191 36", // amber-400 - Warm yellow
      background: "28 25 23", // stone-900 - Deep dark
      surface: "41 37 36", // stone-800 - Elevated dark
      text: "250 250 249", // stone-50 - Light text
      textMuted: "168 162 158", // stone-400 - Muted on dark
      border: "234 179 8", // yellow-500 - Bright borders
      accent: "34 197 94", // green-500 - Vibrant green
    },
  },

  typography: {
    fontFamily: {
      base: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      heading: '"Playfair Display", Georgia, serif',
      mono: '"JetBrains Mono", "Fira Code", Consolas, monospace',
    },
    fontSize: {
      xs: "0.813rem", // 13px
      sm: "0.938rem", // 15px
      base: "1.063rem", // 17px - Larger base
      lg: "1.25rem", // 20px
      xl: "1.5rem", // 24px
      "2xl": "1.875rem", // 30px
      "3xl": "2.5rem", // 40px - Bolder headings
      "4xl": "3.5rem", // 56px - Magazine-style huge titles
    },
  },

  layout: {
    container: "1400px", // Wider container
    gutter: "3rem", // More spacing
  },

  layouts: {
    post: {
      default: {
        file: "layouts/post/default.astro",
        label: "Magazine Default",
        description: "Bold magazine-style layout with large typography",
      },
      sidebar: {
        file: "layouts/post/sidebar.astro",
        label: "Magazine Sidebar",
        description: "Grid layout with featured sidebar content",
      },
      wide: {
        file: "layouts/post/wide.astro",
        label: "Magazine Wide",
        description: "Full-bleed imagery with overlaid text",
      },
    },
    page: {
      default: {
        file: "layouts/page/default.astro",
        label: "Magazine Page",
        description: "Standard magazine page with bold headers",
      },
      fullwidth: {
        file: "layouts/page/fullwidth.astro",
        label: "Magazine Showcase",
        description: "Full-width showcase layout",
      },
    },
  },

  darkMode: {
    strategy: "class",
    attribute: "data-theme",
    defaultMode: "light", // Magazine themes often default to light
    storageKey: "gl-magazine-theme",
  },
}

export default themeConfig
