# Default Theme for Go Live CMS

The default theme for Go Live CMS, featuring multiple layout variants and full dark mode support.

## Features

✅ Multiple layout variants for posts and pages
✅ Dark mode support with manual color schemes
✅ Responsive design
✅ Type-safe configuration
✅ Child theme support ready
✅ Clean, modern design

## Structure

```
themes/default/
├── theme.config.ts          # Theme configuration
├── layouts/
│   ├── base.astro          # Base HTML structure
│   ├── post/
│   │   ├── default.astro   # Clean, centered post layout
│   │   ├── sidebar.astro   # Two-column with sidebar
│   │   └── wide.astro      # Full-width content
│   └── page/
│       ├── default.astro   # Standard page layout
│       └── fullwidth.astro # Full-width page with hero
```

## Layout Variants

### Post Layouts

**Default** - Clean, centered layout ideal for blog posts

- Max width: 800px
- Focused reading experience
- Featured image support
- Author and date metadata

**Sidebar** - Two-column layout with sidebar

- Main content + 300px sidebar
- Sticky sidebar on desktop
- Responsive (stacks on mobile)
- Perfect for additional context

**Wide** - Full-width immersive layout

- Max width: 1400px
- Large hero image (500px height)
- Ideal for photo essays, portfolios
- Dramatic visual impact

### Page Layouts

**Default** - Standard page layout

- Max width: 1000px
- Clean header with title
- Suitable for most static pages

**Fullwidth** - Edge-to-edge layout

- Gradient hero header
- Full-width content sections
- Perfect for landing pages

## Dark Mode

The theme includes full dark mode support with manually crafted color schemes:

### Light Mode

- Primary: `#3b82f6` (blue-500)
- Background: `#ffffff`
- Text: `#0f172a` (slate-900)

### Dark Mode

- Primary: `#60a5fa` (blue-400, lighter for contrast)
- Background: `#0f172a` (slate-900)
- Text: `#f1f5f9` (slate-100)

### User Preferences

Users can choose from three modes:

- **Light** - Always light theme
- **Dark** - Always dark theme
- **System** - Respects OS preference (default)

Preference is stored in `localStorage` as `gl-theme-preference`.

## Customization (Phase 2)

The theme is built to support customization through the admin panel:

- Color schemes
- Typography
- Layout selection per post
- Logo and branding

## Development

### Creating a Child Theme

```typescript
// themes/my-theme/theme.config.ts
export default {
  name: "My Custom Theme",
  parent: "default",
  version: "1.0.0",

  // Override specific colors
  colors: {
    light: {
      primary: "220 38 38", // red-600
    },
  },

  // Inherit everything else from parent
}
```

Then override specific layouts:

```
themes/my-theme/
├── theme.config.ts
└── layouts/
    └── post/
        └── sidebar.astro  # Custom sidebar layout
```

## CSS Variables

The theme exposes CSS variables for easy customization:

```css
:root {
  --color-primary: <RGB values> --color-background: <RGB values> --color-text: <RGB values> --font-base: <font stack>
    --font-heading: <font stack> --container-width: 1200px --gutter: 2rem;
}
```

## Browser Support

- Chrome/Edge (latest 2 versions)
- Firefox (latest 2 versions)
- Safari (latest 2 versions)
- Mobile browsers (iOS Safari, Chrome Mobile)

## License

MIT
