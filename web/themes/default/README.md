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
├── lib/                   # Pure helpers (byline names, reading time, avatar)
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

Every post layout ends with the post's terms, older / newer links and "More to read"
(#351, `src/lib/relatedPosts.ts`). The sidebar layout adds "On this page" (H2s with their
H3s, only from three headings up, hidden below 1000px) and the other posts in the post's
first category. Headings get ids from their text (`src/components/blocks/utils/headingAnchors.ts`);
`THEME_ELEMENT_IDS` in `lib/posts.ts` lists the ids the theme's own markup uses, which a
heading never takes. Add any new element id there.

## Fonts

Literata (variable, opsz + wght), Inter 400–700 and JetBrains Mono 400/500, latin
subsets from @fontsource 5.3.0, served from `/themes/default/fonts/`. Readers' browsers
make no requests to font CDNs. Each family's SIL Open Font License is beside its files.

## Menus

The theme declares two menu locations in `theme.config.ts` (`menuLocations`), and
the admin assigns a menu to each under Appearance › Menus (#347):

- **primary** (Header): the top-level links beside the title. A link with children gets
  a disclosure button that opens them; at phone width everything is in the phone menu,
  children indented under their parent. With no menu assigned, the header shows the site
  title only.
- **footer** (Footer): each top-level link with children is a column headed by its
  label; the other top-level links go in the "Site" column, before the RSS feed.

`base.astro` fetches both (`src/lib/menus.ts`, `GET /public/menus/:location`). The API
resolves every URL from its target when the menu is read, so links follow slug changes,
and leaves out items whose content is unpublished, deleted or not public.

## Search

`layouts/search/default.astro` renders `/search?q=` (#145): the form, the result count,
All / Posts / Pages chips, and each hit's type, date, highlighted title and excerpt and URL
path; with no match, "No results for …", tips, topic chips (the most used categories, each
a search for its name until #348 gives them archives) and recent posts. Results come from the API's `/public/search` (Postgres full-text search,
published posts and pages only) through `src/lib/search.ts`, in numbered pages like the
other lists (`/search/page/2/?q=`). The highlights are the API's escaped HTML with only
`<mark>` added; the query itself is only ever rendered as text. The header's search link,
the phone menu's field and the 404's form (`components/SearchForm.astro`, a plain GET
form) all go there. Search pages are `noindex` and never in the sitemap.

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
| Category and tag archives, category eyebrows, linked tags | #348 |
| The "All <category> →" link under the sidebar's category list | #348 |
| Author photos (initials until then; author pages and cards are #350) | #334 |
| Tagline and site logo | #330 |

GoLive's own mark appears only in the footer's "Published with GoLive" credit.

## License

MIT (the fonts are under the SIL Open Font License 1.1).
