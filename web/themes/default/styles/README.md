# Default Theme - SCSS Structure

## Overview

All theme styles are now organized in separate SCSS files for better maintainability and organization.

## File Structure

```
styles/
├── _variables.scss      # Theme variables (colors, fonts, spacing)
├── _base.scss          # Base styles, resets, CSS custom properties
├── layouts/
│   ├── _post.scss      # Post layout styles (default, sidebar, wide)
│   └── _page.scss      # Page layout styles (default, fullwidth)
└── theme.scss          # Main entry point (imports all partials)
```

## Usage

The main `theme.scss` is imported in `layouts/base.astro`:

```astro
import '../styles/theme.scss'
```

This compiles all SCSS and makes styles available to all layouts.

## Customization

### Changing Colors

Edit `_variables.scss`:

```scss
$color-primary-light: 59 130 246; // Change primary color
$color-primary-dark: 96 165 250; // Change dark mode primary
```

### Adding New Styles

Create a new SCSS file and import it in `theme.scss`:

```scss
// styles/_custom.scss
.my-custom-class {
  color: red;
}

// styles/theme.scss
@use "variables" as *;
@use "base";
@use "layouts/post";
@use "layouts/page";
@use "custom"; // Add your custom styles
```

### Layout-Specific Overrides

Add scoped styles directly in layout files when needed:

```astro
<BaseLayout>
  <!-- content -->
</BaseLayout>

<style lang="scss">
  @use '../styles/variables' as *;

  .my-override {
    color: rgb(var(--color-primary));
    padding: $spacing-lg;
  }
</style>
```

## CSS Custom Properties

Variables are converted to CSS custom properties in `_base.scss`:

```scss
:root {
  --color-primary: #{$color-primary-light};
  --color-text: #{$color-text-light};
  // ...
}

[data-theme="dark"] {
  --color-primary: #{$color-primary-dark};
  --color-text: #{$color-text-dark};
  // ...
}
```

Use them in components:

```scss
.element {
  color: rgb(var(--color-text));
  background: rgb(var(--color-background));
}
```

## Responsive Design

Breakpoints are defined in `_variables.scss`:

```scss
$breakpoint-sm: 640px; // Mobile
$breakpoint-md: 768px; // Tablet
$breakpoint-lg: 1024px; // Desktop
$breakpoint-xl: 1280px; // Large desktop
```

Use in your styles:

```scss
.my-element {
  padding: $spacing-xl;

  @media (max-width: $breakpoint-md) {
    padding: $spacing-md;
  }
}
```

## Benefits of SCSS Organization

✅ **Separation of concerns** - Styles separated from markup
✅ **Reusability** - Import variables in any SCSS file
✅ **Maintainability** - Easy to find and update styles
✅ **Performance** - Compiled to optimized CSS
✅ **Type safety** - Sass catches errors at compile time
✅ **Version control** - Better diffs, easier code review
