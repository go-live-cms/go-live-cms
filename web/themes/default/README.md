# Default Theme for Go Live CMS

The theme a new site starts with (#345), built from the "GoLive Default Theme" design
canvas: a serif for reading (Literata), a sans for everything around it (Inter), one
green for anything you can click, light and dark.

## Structure

```
themes/default/
├── theme.config.ts        # Tokens (colours, type, widths, spacing, radius) + layouts
├── tokens.ts              # Tokens -> CSS custom properties (inlined by base.astro)
├── styles/theme.css       # Plain CSS, served as is; reads only var(--...)
├── fonts/                 # Self-hosted woff2 (latin) + each family's OFL.txt
├── scripts/theme-init.js  # Light / Dark / System switch and the phone menu
├── components/            # Header, footer, byline, post header, list item, ...
├── lib/                   # Pure helpers (byline names, reading time, avatar, nav)
└── layouts/
    ├── base.astro         # <head>, header, footer
    ├── home/default.astro       # Front page (/)
    ├── archive/default.astro    # A post type's list (/post)
    ├── post/{default,sidebar,wide}.astro
    ├── page/{default,fullwidth}.astro
    └── error/default.astro      # 404 and 500
```

The post layout is chosen per post type on the admin Themes screen (`layout_variants`,
read by `getPostLayoutVariant`).

## Fonts

Literata (variable, opsz + wght), Inter 400–700 and JetBrains Mono 400/500, latin
subsets from @fontsource 5.3.0, served from `/themes/default/fonts/`. Readers' browsers
make no requests to font CDNs. Each family's SIL Open Font License is beside its files.

## Light, dark, system

Readers pick Light, Dark or System from the header (and the phone menu); the choice is
stored under `darkMode.storageKey`. `scripts/theme-init.js` loads from `<head>` as a plain
`<script src>`, so the theme is set before the first paint and it works under a CSP of
`script-src 'self'`. Without JavaScript the page follows the system setting.

## Hidden until their issues land

The design shows these; the theme leaves them out rather than faking them:

| Part | Issue |
|------|-------|
| Image captions, wide / full images, quote citations (styles are ready) | #346 |
| Navigation menus (the header has the title and Posts) | #347 |
| Category and tag archives, category eyebrows, linked tags | #348 |
| Author pages and author cards | #350 |
| Related and older/newer posts, table of contents | #351 |
| Search | #145 |
| Tagline and site logo | #330 |

GoLive's own mark appears only in the footer's "Published with GoLive" credit.

## License

MIT (the fonts are under the SIL Open Font License 1.1).
