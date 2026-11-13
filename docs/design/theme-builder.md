# Theme builder: global styles, block templates and template parts (#412)

Status: **design, accepted with the decisions in section 16**, 2026-11. No code ships with
this document.

Builds on: `docs/design/plugin-system.md` section 8 (runtime loading; 8.7 is #412's part),
`docs/design/block-library.md` (#352: the nesting table, containers, the catalog),
`docs/design/block-map-yjs-schema.md` (#315: Option C). Read with:
`web/gl-admin/lib/collaboration/CLAUDE.md` (the hard rules; "rule N" below means those),
`web/collab-server/CLAUDE.md`, `web/themes/README.md`, `web/themes/default/README.md`.
Related issues: #336 (front page, page templates), #358 (publish snapshot), #345 (default
theme), #337 (design tokens), #347 (menus), #322 (post templates), #324 (activity), #185
(caching, being built in parallel), #332 (theme upload, Post-MVP).

## Summary

Today a theme is Astro code resolved when the image is built, and changing how the site
looks means editing code and deploying. This document designs a WordPress-style site
editor on top of that, without replacing it:

1. **Code themes stay the base.** A theme's `.astro` layouts and `theme.config.ts` tokens
   are its defaults. The builder stores **overrides per theme**: global styles, and block
   templates and template parts. "Reset to theme default" removes an override, and the
   code takes over again.
2. **Rendering is data at request time, with one branch** (plugin-system 8.7). A route
   resolves a ranked list of template slugs (section 3.2). The most specific one that has a
   builder template or a code layout wins, and a builder template beats a code layout of
   the same rank. A builder template renders through one generic layout,
   `BlockTemplateLayout.astro`, over `BlockRenderer`. Nothing is compiled or loaded at
   runtime.
3. **Site blocks are core blocks.** Site title, tagline and logo, navigation, search,
   template part, post title, content, excerpt, date, byline, terms and featured image, and
   the query loop with its pagination are ordinary Block Spec types, in the image. They
   change the schema fingerprint once, in their own deploy. They read data from a render
   context that SSR fills before the synchronous render. Outside a template they render
   nothing. The comments block waits for reader comments, which get their own issue.
4. **Templates and parts get their own tables, not posts.** This is #322's argument: no
   read of `posts` should have to remember to leave them out. They mirror a post's
   collaborative shape: a working `block_doc`, Yjs state, a published snapshot and
   versions.
5. **Template editing is collaborative.** It reuses the editor and Hocuspocus as a second
   document kind, `template-<id>`, on the same server, the same schema and the same
   fingerprint. A single-editor mode would bring back a client-side content save, which P5
   deleted, and fork every block feature's tested path. All hard rules apply unchanged
   (section 7.3).
6. **Global styles are a validated partial override of the theme's tokens.** They are
   stored per theme, emitted by the existing `themeCssVariables` in light and dark, and
   edited in a plain form (not collaborative), with optimistic concurrency. Values pass a
   strict grammar shared by Go and TypeScript, so nothing free-form reaches a `<style>`
   tag. Contrast is checked on the pairs `tokens.test.ts` checks, and a failing pair is a
   warning that publish asks to confirm.
7. **Drafts, preview and one publish.** Every edit is a draft. **Publish site design**
   snapshots every changed template, part and style of the active theme in one transaction,
   so readers never see a new header with old colours. A preview reads drafts through an
   authenticated route, behind a short-lived cookie, never through `/public`, and is never
   cached.
8. **#336 fits as is.** A page's template picker also lists builder page templates (stored
   as `block:<name>`, which no layout file name can be). The front page gets a
   `front-page` slug ahead of today's chain.
9. **Admin only, logged, purged.** Every route is `requireSiteAdmin`, and the collab server
   lets only admins open a template document. Activity verbs are recorded under
   `site_design`. A publish fires one site-wide purge through #185's hook.
10. **Export is last.** It produces a data-only child theme for #332. That waits for #332's
    package format and for child-theme resolution, both Post-MVP. A data-only package
    activates without a site build.
11. **The default theme becomes block templates** once the builder renders them, so
    customizing it starts from exactly what readers see. Its templates then serve as the
    starters for every other code theme.

The phased plan is section 15. Section 16 records the decisions taken on review and the
questions still open.

---

## 1. Where things stand

- **Layouts are build-time globs.** `PostPage.astro`, `index.astro`, `[post_type]/index.astro`,
  `term.archive.astro`, `search/index.astro`, `author/[username].astro` and
  `ThemedErrorPage.astro` each `import.meta.glob` the themes' layouts. `lib/themeLayout.ts`
  ranks the candidates: `themeLayoutCandidates` (the active theme's `layouts/{kind}/{variant}`,
  its default variant, then the default theme's), `postLayoutCandidates` (the type's own
  layouts, then `layouts/post`) and `pageLayoutVariant` (#336). `loadThemeLayout` takes the
  first that is in the build.
- **Layout props are a contract.** `themes/README.md` ("Layout Props") lists what each kind
  receives. A post layout gets `post`, `title`, `description`, `seo`, `terms`, `authors`,
  `featuredImage`, `siteTitle` and `urlStructure`. A list layout gets `list` (`PostListData`).
  The route computes SEO, bylines and terms before the layout runs.
- **Tokens (#337, #345).** `theme.config.ts` holds `colors.light`/`colors.dark`,
  `blockColors`, `typography` (families, an eight-step fluid size scale, line heights),
  `layout` (container, gutter, content and wide widths, header height), `spacing` (1–10) and
  `radius`. `tokens.ts` turns them into custom properties under three selectors (`:root`,
  `prefers-color-scheme: dark` unless `data-theme="light"`, and `[data-theme="dark"]`), and the
  default theme's `base.astro` inlines the result. `styles/theme.css` only reads `var(--…)`.
  `tokens.test.ts` checks 4.5:1 in both palettes and that every `var()` is defined.
- **The default theme's chrome is components.** `base.astro` renders `SiteHeader` (site
  title as text, the `primary` menu, search link, the Light/Dark/System switch) and
  `SiteFooter` (title, tagline, the `footer` menu as columns). `scripts/theme-init.js` is a
  render-blocking `<script src>`, never inline, because of CSP.
- **Page templates and the front page (#336).** `posts.page_template` names a
  `layouts/page/<name>.astro` (CHECK `^[A-Za-z0-9_-]{0,64}$`, `''` = default). It is a post
  setting, so it is in `golive_post_settings()`, the published snapshot and every version. A
  name the active theme lacks renders as default and stays stored. `settings.front_page_id`
  picks the page `/` renders; `GET /public/front-page` answers 404 when there is none or it
  is not published.
- **Publish snapshot (#358).** A post has its working `block_doc`, and
  `published_block_doc`, `published_settings` and `published_version_id`, written by
  `PublishPostTx` with a `post_versions` row. `/public` reads only the published side.
  Versions are restored through the editor (rule 9).
- **Theme settings.** `theme_settings` (000007) holds `layout_variants`. `extension_settings`
  holds `theme:<slug>:<key>` rows (#451). Both are publicly readable on purpose:
  `GET /themes/:id/settings` and `/extension-settings` are in `route_auth_test.go`'s public
  list.
- **Menus (#347)** are assigned to the active theme's `menuLocations`, edited on
  Appearance › Menus, and read by `GET /public/menus/:location`.
- **Post templates (#322)** are starter content in their own table, with no collab document,
  and their migration explains why they are not posts.
- **`BlockRenderer` is synchronous.** It renders a Block Spec doc through the registry. Data
  it needs is on the doc before the render (`doc.media`, attached by
  `/public/posts/:id/blocks`). Top-level blocks get `b-<id>` anchors (#356), headings get
  slug ids (`headingAnchors`, #351), and it adds `gl-embeds.js` for a doc with an embed
  (#425).
- **The collab server knows one document kind.** `isCollabDocName` accepts `post-<id>`
  only. Load, store, access and flush are all post routes on the API's internal listener.
- **Activity (#324)** is append-only, with ids and non-personal details only. `object_type`
  is free-form (`^[a-z][a-z_]{0,39}$`).
- **Backups** are `pg_dump` plus the uploads volume (`docs/operations/backups.md`).
  `scripts/backup/test-restore.sh` runs every migration up, down and up.
- **#185 is not built.** Public pages have no cache headers and no purge hooks yet.

### 1.1 Three things called "template"

| | What it is | Where |
|---|---|---|
| **Post template** (#322) | Starter content for a new post | `post_templates` |
| **Page template** (#336) | The layout one page renders with | `posts.page_template` |
| **Site template** (#412) | A block document that lays out a whole kind of route | new, section 5 |

Decision: in code and SQL, #412's objects are **site templates** (`site_templates`, with a
`kind` of `template` or `part`). In the admin they are "Templates" and "Template parts" in
the **Site editor**. #336's picker keeps the label "Template", and section 10 lets it list
builder templates.

### 1.2 Problems found while writing this

| # | Problem | Where | Consequence |
|---|---|---|---|
| 1 | Theme settings are public by design. | `themes_routes.go`, `extension-settings` | Draft global styles must not be stored there, or anyone could read an unpublished design. Section 5.1 gives them their own table. |
| 2 | The theme does the token emission itself: `base.astro` imports its own config and calls `themeCssVariables(themeConfig)`, and hard-codes `theme-init.js`. | `themes/default/layouts/base.astro` | Neither an override nor a generic layout can get in. Section 3.5 gives themes a contract. |
| 3 | "Used in" and media deletion warnings only know posts. | `post_media` | A logo or cover image in a header part could be deleted without a warning. Section 5.6. |
| 4 | Heading ids are unique per doc only. | `headingAnchors`, `THEME_ELEMENT_IDS` | A heading in a template and one in the post it frames could get the same id. Section 3.4. |
| 5 | The embed loader is added once per `BlockRenderer`. | `BlockRenderer.tsx` | A template whose part and post both have embeds would add it twice. Section 3.4. |

---

## 2. Scope

**In:** global styles (colours, typography, layout widths, spacing, radius) in light and
dark; templates for every public route kind except the 500 page; template parts (header,
footer, and any part an admin makes); the site blocks; drafts, preview, one publish,
versions, restore; reset; #336 integration; activity; caching hooks; admin screens (named,
not drawn).

**Not in this design:**

- **A custom CSS field.** It would be the only free-form CSS on the site and needs its own
  sanitizer (open question 3).
- **Font uploads.** Families come from what the theme ships, plus system stacks.
- **Per-block style presets** (WordPress's `styles.blocks`). Block colours stay the #356
  palette.
- **A comments block, for now.** There is no reader-comments feature yet. #192 comments are
  editorial and never public. Reader comments are planned (decided) as their own issue, and
  the block (T18) follows them.
- **Scheduled design publishes.**
- **Editing templates on a phone** (open question 2).
- **Per-template "Last edited by" and comments.** #328 and #192 stay post features in v1.

---

## 3. Rendering model

### 3.1 Options

| | A. **Generic renderer over data, per request** (chosen) | B. Compile templates to `.astro` on publish | C. Render in the browser |
|---|---|---|---|
| How | SSR reads the published template doc from the API and renders it with `BlockRenderer` inside one generic layout | Publishing generates `.astro` files and runs the site build of plugin-system 8.5 | The page ships a template doc and a client renderer |
| Needs a loader | No | Yes: the builder service, S11 and S12 | No |
| Time to go live | The next request | A build | The next request |
| SEO, no-JS readers | Unchanged | Unchanged | Worse |
| Cost per request | One cached read, plus the data its blocks need | None extra | Moved to the reader |
| Verdict | **Use** | Rejected: it makes #412 wait for #332's builder, for no gain the render cost justifies | Rejected |

A is what plugin-system 8.7 already concluded. This section works out its details.

### 3.2 Which template a route uses

Every route has a ranked list of **slugs**, most specific first. Each slug is matched
against three sources: a published builder override for the active theme, a block template
the theme ships (section 5.7), and the theme's code layout for that rank.

| Route | Slugs, most specific first | Code layout at each rank today |
|---|---|---|
| `/` with a front page (#336) | `front-page`, then the page's own list (below) | `PostPage.astro` with the page's layouts |
| `/` latest posts | `front-page`, `home` | —, `layouts/home` |
| `/{type}` list | `archive-{type}`, `archive` | —, `layouts/archive` |
| A post of type `t` | `single-{t}`, `single` | `layouts/{t}/{variant}`, `layouts/post/{variant}` |
| A page | `page-{template}` when it has one, `page` | `layouts/page/{template}`, `layouts/page/default` |
| A page with a builder template | `custom-{name}`, `page` | —, `layouts/page/default` |
| `/{taxonomy}/{slug}` | `taxonomy-{taxonomy}`, `archive` | `layouts/term`, `layouts/archive` |
| `/author/{username}` | `author`, `archive` | `layouts/author`, `layouts/archive` |
| `/search` | `search` | `layouts/search` |
| 404 | `404` | `layouts/error` |
| 500 | **never a builder template** | `layouts/error` (the API is likely down) |

The rule: **walk the ranks in order. At each rank, a builder override or a theme block
template wins over a code layout of the same rank. A rank with neither is skipped. The
default theme's code layouts are the last resort, as today.** A builder `single` therefore
replaces `layouts/post/*`, but not a theme's own `layouts/product/default.astro` for
products. That matches WordPress's hierarchy. The overview screen (section 13) always says
which source each route uses, so an admin who customizes "Archive" can see that category
pages still use the theme's term layout and customize that one instead.

Today's `layout_variants` choice (default, sidebar or wide per type) is a code-layout
setting. Once `single` is customized it no longer applies to posts, and the Themes screen
says so.

### 3.3 The one branch

`lib/themeLayout.ts` gains `resolveTemplate(slugs)`. It makes one call,
`GET /public/site-templates/resolve?slugs=single-post,single` (for the active theme), cached
per section 11. The answer is the first slug, in rank order, that has a published override or a theme block
template. It carries that slug's rank, its doc with `media` attached, and the published
parts it references, each with its media. Otherwise the answer is 404. The caller compares
the rank with that of the first **active theme's** code layout in the glob, which is a
synchronous check. The default theme's layouts don't take part in the comparison: they are
the last resort after every rank, so a builder `archive` beats `default/layouts/term` when
the active theme has no term layout. If the builder's rank is the same or more specific, the route renders
`BlockTemplateLayout`. Otherwise it renders the code layout, as today. Each route file
changes by one call, and the props it computes don't change.

### 3.4 `BlockTemplateLayout.astro`

One component in core, shipped in the image once (plugin-system 8.6's "one new generic
renderer"). It takes **exactly the props of the layout kind it replaces**, plus the
resolved template. So SEO, bylines, terms and `PostListData` are computed by the route as
today, and `SeoHead` receives the same `seo`.

1. **Collect what the blocks need.** `collectTemplateNeeds(template, parts)` walks the docs
   and returns query blocks with their attrs, menu locations, and whether the logo is used.
2. **Fetch it in parallel** through existing `/public` routes, each with a 2s timeout
   (section 4.3), with `requestIdHeaders()`. Site settings come from the per-request
   `getSiteSettings(Astro.locals)`.
3. **Render.** The head has `SeoHead`, the theme's tokens with the published global styles
   (section 6.4), the theme's registered styles and scripts, and `<slot name="head">`. The
   body is the template's doc rendered by `BlockRenderer` inside a `SiteRenderContext`
   provider. That context holds the route (kind, post, term, author, search query, page),
   the fetched data, the parts by slug, and `inTemplate: true`.

`BlockRenderer` stays synchronous. Three of its behaviours need a rule here:

- **Anchors.** A template's blocks render **without** `b-<id>` anchors. The post rendered
  by `post_content` keeps them, so #356's "Copy link to block" still points at the post's
  blocks.
- **Heading ids (problem 4).** The template's headings get their ids first. They are passed
  to the post's `headingAnchors` as reserved ids, as `THEME_ELEMENT_IDS` is today, so a
  table of contents and the anchors still agree.
- **The embed loader (problem 5)** is added once per page. Nested renderers report that
  they need it through the context, instead of each adding the script.

### 3.5 What a theme must provide

Problem 2 is fixed by a small contract, which the default theme adopts first:

- **`resolveThemeTokens(config, globalStyles)`** (core, `src/lib/themeTokens.ts`) merges the
  published override into the theme's config, and `themeCssVariables` (moved into core from
  the default theme's `tokens.ts`) emits it. The middleware reads the published global
  styles once per request into `Astro.locals.globalStyles`. A theme's base layout calls
  `resolveThemeTokens(themeConfig, Astro.locals.globalStyles)` where it calls
  `themeCssVariables(themeConfig)` today. A theme that never calls it just ignores global
  styles, and the Site editor says the theme doesn't support them
  (`supports.globalStyles`).
- **Every script and style the shell needs is in `config.assets`**, with a new `blocking`
  flag for a render-blocking script such as `theme-init.js`. That way the generic layout can
  include what the theme's base layout includes.
- **`<TemplatePart slug="header">`** (core component). It renders the published part when
  there is one, and its slot (the theme's own `SiteHeader`) otherwise. A code theme that uses
  it lets admins customize just the header and footer, without converting any template. The
  default theme's `base.astro` uses it for both. This is likely the most-used feature of the
  builder, so it ships early (T9).
- **Site block styles.** A theme styles the site blocks' markup (`themes/README.md` gains the
  markup, as for content blocks). The default theme's `theme.css` styles all of them, and
  `layoutBlocks.test.ts`-style tests check that every `var()` is defined.

### 3.6 Plugin-system 8.7, point by point

| 8.7 says | This design |
|---|---|
| Templates and styles live in tables, reach SSR through `/public`, cached | 5.1, 3.3, 11 |
| `themeLayout.ts` gets one branch | 3.3 (one call per route file, one comparison) |
| Reset deletes the override | 9: it clears the published override on the next publish, and keeps history |
| Site blocks are core, one fingerprint change | 4.1, 7.4 |
| `BlockRenderer` is synchronous, data attached before | 3.4, 4.3 |
| Collaborative editing makes a new doc kind | 7 |
| Export produces a #332 package | 14 |

---

## 4. Site blocks

### 4.1 They are core blocks

Site blocks are Block Spec types like `paragraph`, defined in `blocks-spec`, with nodes in
`schemaExtensions()`, Go sanitizers with allowlists, and renderers in
`src/components/blocks/`. They are **not** namespaced and not a theme's or a plugin's: every
theme must be able to render them, and the generic layout depends on them.

| Type | Kind | Block Spec attrs | Reads from the context |
|---|---|---|---|
| `site_title` | flow atom | `level` (0 = `<p>`, 1–2), `link` (to `/`) | site settings |
| `site_tagline` | flow atom | — | site settings |
| `site_logo` | flow atom | `width` (px, 32–600), `link` | a new site setting, `site_logo_media_id`, and its media |
| `navigation` | flow atom | exactly one of `location` (one of the active theme's `menuLocations`) or `menuId` (any menu, decided); `layout` (`row`/`column`), `overlay` (`phone`/`never`) | `location`: `/public/menus/:location`. `menuId`: attached by the resolve route (3.3), only for menus a published template or part names, so no public route serves an arbitrary menu by id. |
| `search` | flow atom | `label`, `placeholder`, `button` (text, capped) | — (a GET form to `/search`, the theme's `SearchForm` markup) |
| `template_part` | flow atom | `slug` | the resolved parts |
| `query` | **container** | `postType`, `perPage` (1–24), `orderBy` (`date`/`title`), `order`, `taxonomy` + `termIds`, `authorId`, `inherit` (use the route's own list) | a `/public` list |
| `post_template` | **container**, only in a `query` | — | the current item |
| `query_pagination` | flow atom, only in a `query` | — | the query's `pagination` (#349's window) |
| `query_no_results` | **container**, only in a `query` | — | whether the query is empty |
| `query_title` | flow atom | `level` | the route: term name, author, "Search results for …", type label |
| `term_description` | flow atom | — | the route's term |
| `post_title` | flow atom | `level`, `link` | the route's post, or the current item |
| `post_content` | flow atom | — | the route's post's `published_blocks` |
| `post_excerpt` | flow atom | `length` (words) | `postExcerpt` |
| `post_featured_image` | flow atom | `aspect` (`auto`/`16-9`/`3-2`/`1-1`), `link` | the published featured image |
| `post_date` | flow atom | `which` (`published`/`modified`), `format` (`long`/`short`) | `formatSiteDate` |
| `post_byline` | flow atom | `avatars` | the published byline (#319) |
| `post_terms` | flow atom | `taxonomy` | the published terms with their links (#348) |
| `post_navigation` | flow atom | — | `/public/posts/:id/adjacent` (#351) |

A menu named by `menuId` that is deleted renders nothing. The Menus page's delete
confirmation names the templates and parts that use it.

**A third set (T16)** is what converting the default theme (5.7) needs: `related_posts`
("More to read", #351), `author_cards` ("Written by", #350), `table_of_contents` ("On this
page"), `color_scheme_switch` (the Light/Dark/System switch), and `readingTime` on
`post_byline`. Each takes one more row here and needs no new mechanism.

`comments` waits for reader comments (section 2). It is T18, after that feature's own
issue.

### 4.2 Where each may sit

`validateBlockDoc(doc, { kind })` gains a `kind`: `post`, `template` or `part`. Go's
`prepareForStore` does the same, with shared vectors (`siteBlockVectors.json`):

- **`post_content`**: at most one per template. Never in a part: a header holding the post
  would render it twice. Never inside a query's `post_template` either: a list item carries
  no body, and the block would otherwise render the route's post once per item.
  `post_excerpt` is the list's block.
- **`template_part`**: in templates only. A part can't hold a part, so parts are never
  recursive and a cycle can't happen. A slug resolves to the active theme's **published
  override**, else the **part the theme ships** (5.7), else **core's starter part** (5.7:
  `header` and `footer` exist). So a template customized on a code theme keeps a header and
  footer before anyone customizes the parts. A slug none of the three has is refused on
  publish (8.2).
- **`query` and its children** follow new rows in the nesting table (block-library 2.2),
  which **stays acyclic**. A `query` may sit at the top level or in a `group`. A
  `post_template` holds flow, `columns`, `details` and `media_text`, but **not** a `group`
  or a `query`. Otherwise group → query → post_template → group would close a cycle. So a
  query loop can't be nested in another query loop.
- **`custom HTML` (`html`) and `footnotes`** aren't offered in templates in v1. Snippets are
  keyed by post (`post_html_snippets`), and a template has no footnote list of its own.
- **In posts, site blocks are inert.** They are in the schema, which has to be one schema
  (section 7.4), but the post catalog doesn't offer them and no parse rule creates them, so
  paste can't. A client that writes one into a post's Yjs doc directly gets a block that
  renders nothing: the renderers return null when `inTemplate` is false. The post still
  stores. Refusing it would make every later store of that post `kept-invalid` until
  someone deleted the block. A query loop *inside* posts is a natural later feature, since
  the data path in 4.3 doesn't care where the block sits (open question 5).

### 4.3 Data, limits and failures

- A query's attrs are a closed vocabulary that maps one to one onto `/public` list
  parameters. `GET /public/posts` gains the ones it lacks (`order_by`, `order`, `terms`,
  `author_id`, `per_page` capped at 24), with #349's pagination. There is no query language
  and no SQL from attrs. A query reads only what `/public` already serves, so drafts,
  trashed posts and non-public types are excluded by construction.
- `inherit: true` takes the route's own list: the term, author, search or type list the
  route has already loaded and passed as props. So an archive template doesn't fetch its
  posts twice, and pagination URLs stay #349's.
- At most **4 query blocks** per rendered page, counting parts. Each query's page number is
  the route's `page` for an inheriting query, and 1 otherwise. A non-inheriting query has no
  pager in v1; its `query_pagination` renders nothing, because two pagers can't share one
  `/page/N/` URL.
- **Failures fail soft**, as menus do (`getMenu`): a failed query or menu renders nothing
  for that block, logged once per request (`site_block_data_failed`, block type, never the
  query string). The rest of the page renders. A failed template resolve (not a 404) falls
  back to the code layout, logged `site_template_resolve_failed`. A broken builder release
  can't take the site down while the theme's code still works.
- Media: `site_logo` and image blocks in templates and parts get `media` attached by the
  resolve route (`attachBlockMedia`), with `media_missing` as for posts (#352).

### 4.4 In the editor

- The catalog gains a **Site** group, and entries gain `contexts: ["post" | "template" |
  "part"]` (default: post, template, part). `menuEntries({ context })` filters on it, so
  site blocks are offered only in the Site editor.
- Site blocks have **no parse rules** (as Custom HTML, #428), so no HTML makes one. The
  paste sanitizer drops their markup.
- Node views show **labelled placeholders** ("Post title", "Query loop · Posts · 10 per
  page", a nav with the location's name). The live preview pane (section 8.3) shows real
  data, rendered by SSR. Rendering real data inside the editor would mean data fetching in
  node views, and two renderers that must agree. That's not worth it in v1.
- A `template_part` block is a locked card ("Header · Edit part"). It opens the part in its
  own editor. Parts are separate documents, and one editor binds one document (section 7.5).
- Settings for a query block live in the Block tab (#417's panel): type, count, order,
  filters and "Use this page's list".

### 4.5 Site, theme and plugin blocks

| | Core content blocks | **Site blocks** | Theme blocks (#376) | Plugin blocks (#456) |
|---|---|---|---|---|
| Namespace | none | none | `theme:<slug>/…` | `plugin:<slug>/…` |
| Where defined | core | core | the theme, `index.ts` | the plugin, `block.json` |
| Offered in templates | yes (not `html`, `footnotes`) | yes | the active theme's | enabled plugins' |
| Offered in posts | yes | **no** (inert if present) | the active theme's | enabled plugins' |
| Reads site data | no | **yes, through the context** | no | no |
| Changes the fingerprint | when added | **once, in their deploy** | with the theme's build | with the plugin's build |

Theme and plugin blocks work in templates exactly as in posts, with their own renderers and
#456's boundary for plugins. **Data-reading ("dynamic") blocks from themes or plugins are not
in v1.** They would need a data contract (who fetches, with what limits). That belongs with
plugin-system S13 (public page injection) and should reuse 4.3's collector.

---

## 5. Storage

### 5.1 Tables

```sql
-- One row per (theme, kind, slug) the admin has customized or created.
CREATE TABLE site_templates (
  id                   bigserial PRIMARY KEY,
  theme_slug           varchar NOT NULL,              -- no FK: a removed theme's rows stay (5.5)
  kind                 varchar NOT NULL CHECK (kind IN ('template', 'part')),
  -- '_' because post type and taxonomy names allow it (identifierRe): single-case_study.
  -- 80 so custom-<name> fits a 64-character name (section 10).
  slug                 varchar NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  title                varchar(120) NOT NULL,
  -- Working copy. Written only by the collab store after creation (rule 11, 7.3).
  block_doc            jsonb   NOT NULL DEFAULT '{}'::jsonb,
  block_revision       bigint  NOT NULL DEFAULT 0,
  working_state        varchar NOT NULL DEFAULT 'custom' CHECK (working_state IN ('custom', 'reset')),
  -- Where the working copy started (section 9: "theme default changed since").
  source               varchar NOT NULL CHECK (source IN ('theme', 'starter', 'blank')),
  source_hash          varchar NOT NULL DEFAULT '',   -- hash of the theme template it started from
  -- Published side. NULL published_block_doc = no override: the theme's default renders.
  published_block_doc  jsonb,
  published_version_id bigint,                        -- FK added after site_template_versions
  created_by           bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  changed_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (theme_slug, kind, slug)
);

-- The collab server's state, as post_ydoc_state is for posts (rule 12).
CREATE TABLE site_template_ydoc_state (
  template_id    bigint PRIMARY KEY REFERENCES site_templates (id) ON DELETE CASCADE,
  state          bytea  NOT NULL,
  epoch          varchar NOT NULL,
  block_revision bigint NOT NULL,
  last_editor_id bigint REFERENCES users (id) ON DELETE SET NULL,
  changed_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per publish of a design: what changed together.
CREATE TABLE site_design_releases (
  id           bigserial PRIMARY KEY,
  theme_slug   varchar NOT NULL,
  published_by bigint REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb      -- slugs and token group names only
);

CREATE TABLE site_template_versions (
  id          bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES site_templates (id) ON DELETE CASCADE,
  release_id  bigint NOT NULL REFERENCES site_design_releases (id) ON DELETE CASCADE,
  version_no  int    NOT NULL,
  block_doc   jsonb,                                  -- NULL: this release reset it (section 9)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

ALTER TABLE site_templates
  ADD CONSTRAINT site_templates_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES site_template_versions (id) ON DELETE SET NULL;

-- Global styles, one row per theme. Not a collab document (section 6).
CREATE TABLE global_styles (
  theme_slug           varchar PRIMARY KEY,
  draft                jsonb  NOT NULL DEFAULT '{}'::jsonb,   -- partial override (6.2)
  draft_revision       bigint NOT NULL DEFAULT 0,             -- optimistic concurrency
  published            jsonb  NOT NULL DEFAULT '{}'::jsonb,
  published_version_id bigint,
  changed_by           bigint REFERENCES users (id) ON DELETE SET NULL,
  changed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE global_style_versions (
  id         bigserial PRIMARY KEY,
  theme_slug varchar NOT NULL,
  release_id bigint  NOT NULL REFERENCES site_design_releases (id) ON DELETE CASCADE,
  version_no int     NOT NULL,
  styles     jsonb   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (theme_slug, version_no)
);

-- "Used in" for media in templates and parts (5.6). Synced like post_media.
CREATE TABLE site_template_media (
  template_id bigint NOT NULL REFERENCES site_templates (id) ON DELETE CASCADE,
  media_id    bigint NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  block_id    text   NOT NULL,
  published   boolean NOT NULL,                       -- in the working copy or the published one
  PRIMARY KEY (template_id, media_id, block_id, published)
);
```

The site logo is a site setting (`settings.site_logo_media_id`, `ON DELETE SET NULL`), so code
themes can show it too. It is edited in Settings › General and in the `site_logo` block's
panel. Its "Used in" entry is "Site logo".

### 5.2 Why not posts of a hidden type

WordPress stores templates as posts (`wp_template`). Here, #322's migration already
rejected that pattern for post templates, and the reasons apply even more strongly: every
read of `posts` (lists, counts, search and its triggers, `/public`, the sitemap, feeds,
menus, related posts, archives, "Used in", activity feeds, the scheduler, the plugin event
trigger) would have to leave a template out, and every new query would have to remember to.
The cost of separate tables is a second collab document kind (section 7), and that cost is
paid once.

### 5.3 Revisions and versions

- `block_revision` and the ydoc state's revision work as for posts. A `block_doc` written
  around the collab server makes the API withhold the stale state, and the server reseeds
  under a new epoch (rule 12).
- **A version is written per publish, only for the items that changed**, all under one
  release. The release gives the History list its natural unit: "Nov 14, 10:02 · Ana ·
  Header, Single post, Colours".
- **Restore is per item.** A template or part version is restored through its editor
  (`restoreVersionLive`, rule 9) into the working copy, and goes live on the next publish.
  A global styles version is restored into `draft` by REST (not collaborative). There is no
  "restore the whole release" button in v1. It would be a loop over items, so it can come
  later without new storage.

### 5.4 Backups

Everything is in Postgres, so `pg_dump` covers it, including the Yjs state table. A restored
backup can leave `site_template_ydoc_state` behind its `block_doc`, and rule 12's reseed
handles that as it does for posts. Media files are in the uploads volume already. Themes'
block templates (5.7) are in the image. The new migrations need working downs, because
`test-restore.sh` and CI's `backup-restore` job run them up, down and up. `backups.md`'s
table gains one row naming the site design tables.

### 5.5 Migrations and theme changes

- **A theme removed from the build:** its rows stay (`theme_slug` has no FK), and so do its
  global styles. The Site editor lists them under "Other themes" with a Delete (which asks
  first). Bringing the theme back brings its design back. This is #336's rule for page
  template names, applied to the whole design.
- **A theme renamed** (a new slug) is a new theme as far as the builder is concerned.
  Customizations aren't copied between themes (16.6).
- **Block Spec changes** apply to template docs exactly as to posts: the seed drops what
  the schema can't build (#213), versions and `meta.dropped` keep it, and #453's reseed
  covers an uninstalled extension block.
- **A token the theme stops declaring** is ignored at emission and flagged in the editor
  ("not in this theme any more"). It stays in the stored override.

### 5.6 Media in templates (problem 3)

Each template store syncs `site_template_media` from the working copy, and each publish
syncs it from the published copy. This mirrors `post_media` (`contentMediaUses` walks the
tree, #352 2.9). `GET /media/:id/posts` gains a `site_templates` list ("Header part",
"Single post template"), and the delete confirmation names them. A deleted media id renders
nothing, as in posts (`media_missing`).

### 5.7 What a theme ships

A theme may ship `templates/<slug>.json` and `parts/<slug>.json`: Block Spec v1 docs with a
small header (`{ "title": "Header", "doc": {…} }`). The API scans them next to
`page_templates` (`themes_scanner.go`), validates them with `prepareForStore` and the kind's
rules, and stores them in the theme's `config` (`block_templates`, `block_parts`, each with
a content hash). A shipped block template **is** that theme's default for its slug, ranked
above the code layout of the same rank (3.2). A theme that ships both for one slug gets a
scan warning, and the block template wins.

**Starters** are core JSON docs (`api/sitedesign/starters/*.json`, `go:embed`) for every
slug and for `header` and `footer`. They are built from site blocks and styled by the
default theme's site-block CSS. "Customize" on a slug whose default is code starts from the
starter, and the editor says so plainly: "Single post uses Default's code layout. Customizing
starts from a block version, which may look a little different. Reset brings back the code
layout."

**The default theme is converted to block templates (decided, T17).** It ships
`templates/*.json` and `parts/*.json` for every route and for its header and footer, so
"Customize" there starts from exactly what readers see. Its rules:

- **Parity first.** The block templates render the same pages as today's layouts, checked
  on `theme.astro.test.ts`'s fixtures. Any differences are listed on the issue and approved
  before the switch.
- **Post layout variants become block templates.** `single`, `single-sidebar` and
  `single-wide` are shipped, and a type's `layout_variants` names which one it uses. T17
  settles the exact mapping as its first acceptance item.
- **The `.astro` layouts go** once parity holds. The one exception is `layouts/error`: the
  500 page must render with the API down.
- **The default theme's templates become the starters.** Core's own starters (T9) exist
  only until T17 lands. After that, customizing on any other code theme starts from the
  default theme's templates.

---

## 6. Global styles

### 6.1 What can be edited

The token groups of `ThemeConfig`. **An override can only change tokens the theme
declares.** It can't add one, because `theme.css` wouldn't read it.

| Group | Tokens | Control | Rule |
|---|---|---|---|
| Colours, light and dark | every key of `colors.light` / `colors.dark` | Colour field (hex, swatch, picker) | `#rrggbb` only |
| Block colours | `blockColors.*.{text,background}` | Same, per #356 token | `#rrggbb` |
| Fonts | `fontFamily.base/heading/mono` | Select | one of the theme's `fontOptions` (a new optional config key: id, label, stack, the `@font-face` it ships) or a system stack from a fixed core list |
| Type scale | `fontSize.*`, `lineHeight.*` | Per step, with a preview | the length grammar (6.3); line heights 1–2.5 |
| Layout | `container`, `contentWidth`, `wideWidth`, `gutter`, `headerHeight` | Length fields | the length grammar; `contentWidth` ≤ `wideWidth` ≤ `container` |
| Spacing, radius | `spacing.1–10`, `radius.*` | Length fields | the length grammar; spacing increasing |

Light and dark are edited side by side, not as two modes. That's how the default theme's
canvas draws them, and it keeps a palette from drifting out of contrast in only one mode.

### 6.2 Shape

The same nesting as `ThemeConfig`, partial:

```json
{
  "colors": { "light": { "primary": "#155e4b" }, "dark": { "primary": "#3fe0b3" } },
  "typography": { "fontFamily": { "heading": "literata" } },
  "layout": { "contentWidth": "720px" }
}
```

Font families are stored as option ids and resolved to stacks at emission, so a theme that
fixes a stack doesn't leave old copies in every site's override.

### 6.3 Validation: nothing free-form reaches CSS

The emitted values go into a `<style>` element, so a value is CSS injection if it can hold
`;`, `}`, `<` or a function the grammar doesn't name. One validator in Go (on every write
and on publish) and one in TypeScript (the form), pinned by `globalStyleVectors.json` read
by both test suites (the `themeBlockVectors.json` pattern):

- **Colour:** `^#[0-9a-f]{6}$` (lowercased on write).
- **Length:** a number with `px`, `rem`, `em`, `%` or `vw`, or
  `clamp(<length>, <length or sum>, <length>)` where a sum is `<length> + <length>`. That
  is exactly the form the default theme's scale uses. Nothing else: no `calc`, `var`, `url`
  or other function.
- **Number:** line heights, a plain decimal.
- **Keys:** only paths the theme declares. Anything else is refused (400 `unknown_token`),
  not dropped. A form that sends an unknown key has a bug worth seeing.

**Contrast.** The pairs `tokens.test.ts` checks (text, textMuted and primary on background
and surface, onPrimary on primary, each block colour as text and as fill), in both palettes,
are computed on every draft save and shown next to the fields. **A failing pair is a
warning, not a refusal (decided).** Publish answers 409 `contrast_unconfirmed`, naming the
pairs, unless the request carries `confirm_contrast: true`. The publish dialog shows the
pairs and a "Publish anyway" confirmation. The release's `summary` and the
`site_design_published` activity record how many pairs failed, so the warning stays visible
afterwards.

### 6.4 Emission

`resolveThemeTokens` (3.5) deep-merges the published override into the config, resolves font
ids, and hands the result to `themeCssVariables`. The output has the same three selectors,
so dark mode, the reader's switch and no-JS readers all behave as today. Fonts an option
names are added to the head as `<link rel="preload">` when the theme declares them.

### 6.5 Editing

A form, not a collab document. `PUT /site-design/global-styles` takes the whole draft with
`base_revision`. A stale one gets 409 `styles_changed` and the other admin's draft is shown,
like #319's byline. Two admins editing styles at the same moment is rare, and colours don't
merge meaningfully character by character.

---

## 7. Template editing is collaborative

### 7.1 Options

| | A. **Second document kind on the collab server** (chosen) | B. Single editor, REST save, edit lock | C. Templates as posts of a hidden type |
|---|---|---|---|
| Editor | The bound editor, as for posts | A new unbound mode that saves | The bound editor |
| Client saves content | **Never** (rule 11) | Yes: the client-save path P5 deleted | Never |
| Server repairs (`repairColumnsFragment`, `repairEmptyContainers`, `repairFootnotesFragment`, id stamping) | Run on every store, as for posts | Would need a second implementation, or must be skipped | Run |
| Block features (#414–#428): moves through `applyBlockMove`, rule 7 guards, relay tests | Reused as tested | Each one's non-collab path untested | Reused |
| Presence, live preview while a colleague edits | Yes | No; a lock instead | Yes |
| New server code | Doc kind: name, load, store, access, flush | None | None |
| Cost elsewhere | — | — | Every read of `posts` (5.2) |
| Verdict | **Use** | Rejected | Rejected |

B looks cheaper and isn't. The editor is "a bound editor and nothing else". Every block built
since P5 was built and tested against that, and several rely on the server's store to repair
what Yjs merges. A second mode that saves from the client would be a second persistence path
in the subsystem with the worst incident history. Admin-only access makes concurrency rare,
but it doesn't make the second path free.

### 7.2 What the collab server gains

- **Doc names:** `template-<id>` beside `post-<id>`. `isCollabDocName` accepts both, and a
  `docKind(name)` helper returns `{kind, id}`. Parts are rows of the same table, so they
  share the prefix.
- **API client per kind:** `GET/PUT /internal/site-templates/:id/collab`, with the #280
  contract unchanged (`block_doc`, `block_revision`, `ydoc_state`, `epoch`, `base_revision`,
  409 behind). `StoreSiteTemplateCollabTx` mirrors `StorePostCollabTx`, without block edits,
  comments, post activity or the plugin event trigger.
- **Access:** the lookup gains the doc kind. For a template only `admin` gets `can_edit`.
  Everyone else is **denied** (`permission-denied`), not given a read-only view, since
  templates are admin-only. `accessMode` becomes kind-aware for this: today any content
  role without `can_edit` maps to read-only, which for a template would give an editor a
  read-only view at connect and turn a demoted admin's connection read-only (`demoted`)
  on a re-check. For a template that case maps to deny at connect and to a close with
  `access-revoked` on a re-check. The timers and `POST /internal/users/:id/recheck` are
  otherwise unchanged, so a demoted admin's template connections close at once. There is no trash for
  templates, so `post-trashed` never applies.
- **Store pipeline:** unchanged steps, with `validateBlockDoc(doc, { kind })` (4.2). A store
  that fails the kind's rules is `kept-invalid`, as today.
- **Block change tracker** (#328): off for templates in v1. It only feeds per-block
  attribution, which templates don't show.
- **Flush:** `POST /internal/documents/template-<id>/flush` is the existing route with the
  wider name check. Publish uses it (8.2).
- **Load:** the same `loadIntoDoc`, so #453's reseed of uninstalled extension blocks
  applies to templates too.

### 7.3 Rule by rule

| Rule | Status |
|---|---|
| 0 (no client cache) | Unchanged; the template editor is the same editor. |
| 7 (no `appendTransaction` on sync) | Site block node views are plain node views. No new ProseMirror plugin. |
| 8, 13 (one yjs) | No new dependency. The bundle's module graph gains site blocks' headless nodes, which import nothing new; `process.test.ts` runs as before. |
| 9 (restore through the editor) | Template versions, "Discard changes" and "Start over from the theme default" all go through `setEditorBlockDoc` (section 9). |
| 10 (never bind what can't be built; fingerprint) | One schema for both kinds, so one fingerprint (7.4). Site blocks change it once. |
| 11 (only the server seeds; nothing writes `block_doc` around it) | The writers of `site_templates.block_doc` are the collab store, and creation ("Customize" or "New template", with no Yjs state yet, as `POST /posts`). Reset doesn't write it (section 9). Nothing else does. |
| 12 (revision, epoch) | `site_template_ydoc_state` has both; the same guards. |
| 14 (empty docs) | The same normalization. An empty template is allowed in the working copy, but **publish refuses an empty template** (it would blank every page of that kind). |

### 7.4 One schema, one fingerprint

Site blocks are in `schemaExtensions()`, so the editor and the collab server have one schema
whatever the document. The fingerprint stays a property of the build, not of the document.

The alternative was a template schema with site blocks and a post schema without. The
server knows the doc name at auth time, so it could compare against the right fingerprint.
But that doubles `schema.test.ts`, `process.test.ts`'s bundle check and the stale-tab matrix.
It also makes "the same node in two schemas" a new failure class, for a gain (site blocks
not buildable in posts) that 4.2's inert rule already provides. **Rejected.**

The deploy that adds site blocks goes through #416's path: tabs on the old bundle get
`schema-mismatch` and reload. That's the same as for every new block since #414.

### 7.5 Parts are edited in their own editor

A template holds `template_part` blocks by slug, never the part's content. Editing the
header from inside a template opens the part's own document. That means one binding per
editor and no nested Yjs documents. WordPress edits parts inline. That's nicer, but it
would need two documents bound into one ProseMirror view, which y-tiptap can't do.

---

## 8. Preview and publish

### 8.1 Drafts

Every template and part has a working copy (the collab document) and a published copy.
Global styles have `draft` and `published`. An item **has unpublished changes** when its
working copy differs from its published copy, or when `working_state = 'reset'` and it still
has a published override. The Site editor shows "Changes not published" per item and
counts them on the Publish button, the #326 vocabulary.

### 8.2 Publish site design

`POST /site-design/publish` (admin) publishes **every** item of the active theme with
unpublished changes, together:

1. **Outside any transaction:** flush each changed template's collab document (`503` from a
   flush stops the publish, as for posts), then validate: kind rules, no empty template,
   and every `template_part` slug resolving to a part by 4.2's order, counting the parts
   this publish puts live. Contrast (6.3) asks for confirmation; it never refuses.
2. **`PublishSiteDesignTx`:** lock the theme's rows (`FOR UPDATE`), insert the release,
   write each changed item's published copy and its version, apply resets (section 9), sync
   `site_template_media`'s published rows, and commit. Nothing else runs inside, which is
   the rule of plugin-system 7.3.
3. **After commit:** the site-wide purge (section 11) and `site_design_published` activity.

**Why one publish, not one per item.** A header part referencing a new part, a template
relying on a new token, a palette change paired with a logo swap: these only make sense
together. Per-item publish would let the site show half a redesign. The publish dialog lists
everything it will publish. **"Discard changes"** on an item puts its published copy back
into the working copy, through the editor for templates (rule 9) and by REST for styles. So
an admin who doesn't want one item in a release discards it first.

### 8.3 Preview

`/public` never serves drafts. That's the issue's rule, and `route_auth_test.go` keeps it so.

1. The admin asks `POST /site-design/preview` and gets a signed token: PASETO v4, audience
   `golive.design-preview`, the admin's id, the theme, 15 minutes.
2. The admin's preview frame posts it to an Astro endpoint, `POST /gl-preview`. That sets an
   `HttpOnly`, `Secure`, `SameSite=Strict`, 15-minute cookie and redirects to the page being
   previewed. The token is **never in a URL**, so no proxy log or `Referer` sees it (#233's
   rule for tickets).
3. While the cookie is present, the middleware reads the draft design from an
   **authenticated** route, `GET /site-design/draft?slugs=…`, with the token as bearer. The
   API checks the token **and** that its user is still an admin. Posts and pages are still
   the published ones.
4. Every previewed response is `Cache-Control: private, no-store` with `X-Robots-Tag:
   noindex`, and carries a fixed banner ("Previewing unpublished design · Exit preview").
   Exit clears the cookie.

The Site editor shows the preview in a frame (same origin, so the admin CSP gains
`frame-src 'self'`) with Desktop and Phone widths and Light and Dark. It reloads the frame
on the collab server's `stored` message for the template being edited, and on each styles
save. The frame always shows what the server has, never the editor's state, which is #355's
rule for History.

### 8.4 Not in v1

Scheduled design publishes, and previewing a design together with draft post content.

---

## 9. Reset to theme default

**Per template or part:** "Reset to theme default" (asks first: "Single post will use
Default's code layout again when you publish. Your version stays in History.") sets
`working_state = 'reset'`. The editor turns read-only with that notice and **Keep editing**,
which sets it back. Nothing writes `block_doc`, so rule 11 is untouched. On publish, the
item's `published_block_doc` becomes NULL and its version records `block_doc = NULL`. The
row and its history stay, so the reset can be undone by restoring an earlier version. A
**Delete** on an item that isn't published removes the row. That's the only way history goes.

**"Start over from the theme default"** (a template whose theme default is a block template,
or a starter) replaces the working copy through the editor (`setEditorBlockDoc`, rule 9).

**Global styles:** "Reset" per group (colours, fonts, type scale, layout, spacing) or
"Reset all" removes those keys from `draft`. It reaches the site on publish.

**The theme changed underneath.** When a deploy changes a theme's shipped block template,
its hash no longer matches `source_hash`, and the item shows "Default changed since you
customized" with **Compare** (#355's diff, theme default against working copy) and **Start
over**. Nothing changes on its own.

---

## 10. Page templates (#336) and the front page

- **Builder page templates.** An admin can create a template of slug `custom-<name>`. It is
  offered only in the page's Template field, next to the theme's page layouts, labelled
  with a "Site editor" tag. The page stores it as `block:<name>`. That needs a migration
  that widens `posts_page_template_name` to `^([A-Za-z0-9_-]{0,64}|block:[a-z0-9-]{1,64})$`.
  A layout file name can never contain `:`, so the two can't collide. `PUT /posts/:id/template`
  accepts a published custom template of the active theme.
- **It is still a post setting.** It's already in `golive_post_settings()`, so it is
  snapshotted, versioned and goes live on Update (#358), with no change.
- **Rendering.** `pageLayoutVariant` gains the branch: a `block:` name resolves `custom-<name>`
  (3.2). If that template is unpublished, deleted or belongs to another theme, the page
  renders with the default and **keeps its stored name**, #336's rule after a theme switch.
- **The `page-<template>` rank** lets an admin customize the theme's own page layouts too:
  customizing "Page · Full width" overrides `layouts/page/fullwidth.astro` for every page
  that picked it.
- **Front page.** `front-page` is the most specific slug for `/` in both modes (3.2).
  Settings › Front page is unchanged. With a page chosen and no `front-page` template, the
  page renders through its own chain, as today. `/page/N/` stays a 404 then.

---

## 11. Caching (#185)

#185 is being built in parallel. This design depends only on what its issue promises: a
cache-aside interface and purge hooks.

- **Reads to cache:** `/public/site-templates/resolve` and the published global styles,
  keyed `design:<theme>:…`. SSR memoizes both per request, like `getSiteSettings`. Until #185
  lands, they are plain reads (one indexed lookup each).
- **What invalidates:** a design publish, theme activation, a change to the front page or
  to `site_logo_media_id`, and a menu save (navigation blocks). Design changes affect every
  page, so **each of these purges everything public**, through #185's hook. A post publish
  purges what #185 already purges for posts. A builder home page with a query loop is the
  same cached page as today's home layout listing posts, with the same purge rule.
- **Never cached:** any response rendered with the preview cookie. The CDN or Caddy bypass
  rule keys on the cookie's presence, as well as `private, no-store` on the response.
- **Request cost.** A builder page makes one resolve read plus at most 4 queries, the same
  order as today's home and archive pages. T9's acceptance measures render time against the
  code layout on the same route.

---

## 12. Access and activity

- **Routes:** everything under `/site-design` is `requireSiteAdmin`, except
  `GET /site-design/draft` (8.3). The middleware calls that one with a design-preview token,
  not an access token, so it verifies the token's audience and expiry itself, then checks
  that the token's user is still an admin, which is `requireSiteAdmin`'s check by another
  path. `route_auth_test.go` names it. The only public reads
  are `/public/site-templates/resolve` (published only) and the published global styles
  (served with `/themes/active`, which is public already). `route_auth_test.go` lists them
  with reasons, and a new case proves a draft is never served by either.
- **Collab:** admins only, enforced at connect and on every re-check (7.2).
- **Activity (#324)**, `object_type = 'site_design'`, admin-only in `ListActivity` (like
  settings events), ids and slugs only:

| Verb | Object | Payload |
|---|---|---|
| `site_template_created` | template id | `kind`, `slug`, `source` |
| `site_template_edited` | template id | — (throttled like the collab `edited`, written in `StoreSiteTemplateCollabTx`) |
| `site_template_reset` / `site_template_reset_cancelled` | template id | `kind`, `slug` |
| `site_template_deleted` | template id | `kind`, `slug` |
| `site_template_restored` | template id | `version_no` |
| `global_styles_updated` | the theme's id | `groups` (names, never values; throttled) |
| `site_design_published` | release id | counts, slugs, style group names |

The site logo is a setting, so changing it is the existing `settings_updated` with
`fields: ["site_logo_media_id"]`. Home's Activity feed reads the new verbs with links into
the Site editor.

---

## 13. Admin screens the redesign canvas needs

The redesign canvas has a Themes board whose active card has **Customize** and **View
site**, with nothing drawn behind Customize. It has no Appearance section (Menus, #347, was
built without a board) and nothing for templates, styles or previews. The default theme
canvas has no logo and no site-block markup. The blocks canvas has no site blocks. To be
drawn (T1), not drawn here:

**Redesign canvas**

1. **"Site editor · overview"**: reached from Themes › Customize. Templates grouped by route
   kind, each saying what renders it now ("Theme layout · post/default", "Customized",
   "Customized · changes not published", "Default changed since you customized"); Template
   parts; Global styles; "Other themes" customizations; **Publish site design** with its
   count.
2. **"Site editor · global styles"**: colours with light and dark side by side and contrast
   flags on each pair, fonts, the type scale, layout widths, spacing and radius, per-group
   Reset, and the preview frame with Desktop/Phone and Light/Dark toggles.
3. **"Site editor · template"**: the post editor's chrome with a template breadcrumb, the
   **Site** group in the inserter, parts as locked cards, a query block's Block tab, and a
   Preview pane beside or instead of the canvas.
4. **"Site editor · template part"**: the same editor for a part, with "Used in 7
   templates".
5. **"Publish site design" dialog**: the list of changes, failing contrast pairs, empty
   templates.
6. **"Reset to theme default"** confirmation, and the read-only "will reset on publish"
   notice.
7. **"New template"** (custom page template) dialog, and the page settings' Template field
   with builder templates (#336's field).
8. **"Site editor · history"**: releases, per item, with Restore; reuse the three History
   boards' patterns.
9. **Empty and error states**: a theme without global styles support; "starts from a block
   version" for a code default; an unbuildable block in a template (#213's notice);
   another admin editing (presence).
10. **Settings › General**: the Site logo field.
11. **Appearance navigation**: where Menus and Site editor sit in the sidebar (today Themes
    is under Workspace, and Menus has no board).

**Default theme canvas:** the preview banner; the header with a logo; the published markup
of the query loop, pagination, navigation and the post blocks (most match existing
components, so this is mostly naming).

**Blocks canvas:** a "Site blocks" board in the editor (placeholders, the part card, query
settings) and in the 1280 and 375 published sections.

Phone width: the overview and the history read at 375. Editing templates and styles is
desktop-only in v1, with "Use a larger screen to edit templates" (open question 2).

---

## 14. Export as a theme package (#332)

Export produces a **child theme of the active theme**, as a #332 package:

```
<slug>/
  theme.json            # name, version, "parent": "<active theme>", supports, menuLocations
  styles.json           # the published global styles, as a full token set
  templates/<slug>.json # every published template override
  parts/<slug>.json
  README.md             # what it was exported from, and when
```

It is **data only**: no `.astro`, no `functions.ts`, no blocks. What it needs that doesn't
exist yet:

- **#332's package format**, which doesn't exist yet. This proposes `theme.json` as the
  data twin of `theme.config.ts`, the way `block.json` twins a theme block's `index.ts`
  (plugin-system 5.1).
- **Child-theme resolution.** `themeLayoutCandidates` falls back to `default`, never to a
  `parent`. `supports.childThemes` and `parent` exist in `ThemeConfig` but nothing reads
  them.

**Decided: a data-only package activates without a site build.** Its templates and styles
are data (plugin-system 8.2, kind 1). Its CSS and fonts are static files (kind 2: a volume
and a file server). So it can be activated in seconds, without S11 or S12, as long as its
parent is in the image. The site build stays the path for packages with code. This makes
#332's first version much cheaper: it can ship data-only packages before the builder
service exists.

Import is the same in reverse. An uploaded data-only theme's templates are that theme's
**defaults** (5.7), so its own Site editor customizes on top of them.

---

## 15. Phased plan

Each phase is shippable alone. The milestone is Post-MVP, like #412 itself.

| Phase | Ships | Depends on |
|---|---|---|
| **0. Design and prep** | T1 canvas boards; T2 theme contract and the default theme's adoption | |
| **1. Global styles** | T3 storage, validation, emission; T4 preview; T5 the styles screen | T2; T1 for T5 |
| **2. Site blocks** | T6 identity, navigation, search, part; T7 post blocks and the query loop | T2 |
| **3. Templates** | T8 storage and the collab document kind; T9 rendering and `<TemplatePart>`; T10 publish, versions, reset | T6 (T7 for T9's full set) |
| **4. Editor and integration** | T11 Site editor screens; T12 #336 builder page templates; T13 caching hooks; T14 media "Used in" | T1, T4, T9, T10; #185 for T13 |
| **5. Default theme** | T16 site blocks III; T17 the default theme as block templates | T7, T9 |
| **6. Later** | T15 export as a theme package; T18 the comments block | #332 and child themes; reader comments |

### Sub-issues

Filed on 2026-11-13, all in Post-MVP: T1 #483, T2 #484, T3 #485, T4 #486, T5 #487, T6 #488,
T7 #489, T8 #490, T9 #491, T10 #492, T11 #493, T12 #494, T13 #495, T14 #496, T16 #497,
T17 #498, T18 #500, T15 #501. Reader comments are #499. P2 here is Medium and P3 is Low.

| # | Title | Size | Priority |
|---|---|---|---|
| T1 | design: Site editor boards, site blocks, preview banner on the canvases | M | P2 |
| T2 | themes: token, asset and part contract for generic rendering; default theme adopts it | S | P2 |
| T3 | site design: global styles storage, validation vectors, contrast, emission | M | P2 |
| T4 | site design: draft preview (token, cookie, authenticated draft reads, banner) | M | P2 |
| T5 | admin: global styles screen | M | P2 |
| T6 | blocks: site blocks I (site title, tagline, logo, navigation, search, template part) | M | P2 |
| T7 | blocks: site blocks II (post blocks, query loop, pagination, no results) | L | P2 |
| T8 | site design: template tables and the `template-<id>` collab document kind | L | P2 |
| T9 | site design: template resolution, `BlockTemplateLayout`, `<TemplatePart>`, starters | L | P2 |
| T10 | site design: publish site design, versions, restore, reset, discard | M | P2 |
| T11 | admin: Site editor (overview, template and part editors, publish, history) | L | P2 |
| T12 | pages: builder page templates in the Template field (#336) | S | P3 |
| T13 | caching: purge and cache-aside for the site design (#185) | S | P3 |
| T14 | media: "Used in" for templates and parts | S | P3 |
| T15 | themes: export the design as a data-only child theme (#332) | M | P3 |
| T16 | blocks: site blocks III (related posts, author cards, table of contents, colour scheme switch) | M | P2 |
| T17 | default theme: ship block templates and parts for every route | L | P2 |
| T18 | blocks: comments site block | S | P3 |
| — | comments: reader comments on published posts (its own design; not part of #412) | L | P2 |

**T1. design: Site editor boards, site blocks, preview banner**
- Scope: the boards in section 13 on the redesign canvas, the site blocks on the blocks
  canvas, and the banner, logo header and site-block markup on the default theme canvas.
- Acceptance: every screen in section 13 has a board with its states (empty, loading,
  error, read-only, another admin present), light and dark where the canvas has both; the
  site blocks have editor and published boards at 1280 and 375; this document is updated
  where a board changes a decision.
- Depends on: nothing.

**T2. themes: token, asset and part contract**
- Scope: `resolveThemeTokens` and `themeCssVariables` in core; `Astro.locals.globalStyles`
  (empty until T3); `assets.scripts[].blocking`; `<TemplatePart>` (renders its slot until T9);
  `supports.globalStyles`; reserved template heading ids; the embed loader once per page; the
  default theme's `base.astro` and config use all of it; `themes/README.md` documents the
  contract.
- Acceptance: the default theme renders byte-identical HTML to before (snapshot tests on
  each layout kind, `theme.astro.test.ts`); `tokens.test.ts` passes on the moved code; a
  theme that doesn't adopt it still renders.
- Depends on: nothing.

**T3. global styles storage, validation, emission**
- Scope: `global_styles`, `global_style_versions` (and `site_design_releases`, which T10
  extends); `GET/PUT /site-design/global-styles` with `base_revision`; the grammar of 6.3 in
  Go and TypeScript with `globalStyleVectors.json`; contrast computation; `fontOptions` in
  the config; published styles served with `/themes/active`; emission through T2; activity
  `global_styles_updated`; a styles-only `POST /site-design/publish` that T10 generalizes.
- Acceptance: injection vectors (`;`, `}`, `</style>`, `url(`, `var(`, `expression(`)
  refused in both validators; an unknown key is a 400; a stale save is a 409 with the
  current draft; a published override changes the page's custom properties in all three
  selectors and nothing else; a failing contrast pair makes publish ask for confirmation
  (`contrast_unconfirmed`, the pairs named) and never refuses it;
  draft values never appear in any `/public` or `/themes` response (route audit case);
  migrations up/down/up.
- Depends on: T2.

**T4. draft preview**
- Scope: section 8.3: the token route, `POST /gl-preview`, the middleware's draft read,
  `no-store` and `noindex`, the banner, Exit; the admin CSP's `frame-src 'self'`.
- Acceptance: the token never appears in a URL or a log line (`log-guard`-style test); a
  non-admin's or expired token renders the published site; a demoted admin's token stops
  working at once; previewed responses are never cacheable; the banner is announced to
  screen readers and keyboard reachable.
- Depends on: T3.

**T5. admin: global styles screen**
- Scope: the screen of section 13 item 2, per T1's board; rules in `lib/globalStyles.ts`
  (tested); contrast flags live; per-group reset; the preview frame.
- Acceptance: every control has a label and keyboard path; the form refuses what the API
  refuses with the same messages (vectors); a 409 shows the other admin's draft; reset per
  group and all; preview reloads on save.
- Depends on: T1, T3, T4.

**T6. site blocks I**
- Scope: `site_title`, `site_tagline`, `site_logo` (with `settings.site_logo_media_id` and the
  Settings field), `navigation`, `search`, `template_part`; the `SiteRenderContext`; inert
  rendering outside templates; catalog `contexts` and the Site group; `validateBlockDoc`'s
  `kind`; Go sanitizers and `siteBlockVectors.json`; default theme styles.
- Acceptance: the full chain per block as #352 requires (spec, Zod, node, sanitizer,
  renderer, theme styles, collab round trip on the relay); `schemaFingerprint.test.ts` pins
  the change; no parse rule creates a site block (paste test); a site block written into a
  post's Yjs doc stores and renders nothing; the deploy note says tabs reload once.
- Depends on: T2.

**T7. site blocks II**
- Scope: `query`, `post_template`, `query_pagination`, `query_no_results`, `query_title`,
  `term_description`, and the `post_*` blocks of 4.1; nesting table rows (acyclic);
  `collectTemplateNeeds`; `/public/posts` filters; the limits and soft failures of 4.3.
- Acceptance: `nestingVectors.json` cases for every new row and the forbidden cycles,
  and `siteBlockVectors.json` refusing `post_content` in a part or a post template; a
  query never returns a draft, trashed or non-public post (DB test); 5 queries on a page
  render 4 and log once; a failed query renders nothing and the page renders; `inherit`
  reuses the route's list (no second fetch, asserted); pagination URLs equal #349's.
- Depends on: T6.

**T8. template tables and the collab document kind**
- Scope: `site_templates`, `site_template_ydoc_state`, `site_template_versions`; the
  internal collab routes and `StoreSiteTemplateCollabTx`; `template-<id>` in the collab
  server (names, kind dispatch, admin-only access, flush); `POST /site-design/templates`
  (Customize from theme default, starter or blank); the theme scan of `templates/` and
  `parts/` (5.7); starters.
- Acceptance: the relay tests a post suite has, on a template (two admins typing, the
  stored doc, a restart, a reseed after `block_doc` is written around the server, a stale
  epoch); an editor is refused at connect and a demoted admin is closed (never made
  read-only) on re-check, through the kind-aware `accessMode`; a slug with `_` stores;
  `process.test.ts` covers the new name; a template whose store fails its kind's rules is
  `kept-invalid`; migrations up/down/up; `web/collab-server/CLAUDE.md` and the collab rules
  file updated.
- Depends on: T6.

**T9. rendering**
- Scope: the slug lists of 3.2 for every route file; `resolveTemplate` and
  `/public/site-templates/resolve` (with the menus that navigation blocks name by id);
  `BlockTemplateLayout.astro`; `<TemplatePart>` reading published parts; anchors, heading
  ids and the embed loader per 3.4; core's interim starters (replaced by T17).
- Acceptance: for each route kind, a published override renders and a reset one falls back
  to code (Astro container tests); rank comparison per 3.2 and 3.3 (a builder `single`
  doesn't beat `layouts/product`; a builder `archive` beats the default theme's term
  layout); a customized template on the default theme renders core's starter header and
  footer until the parts are customized; the 500 page never resolves a template; `SeoHead` output is identical
  to the code layout's for the same post; a failed resolve renders the code layout; render
  time measured against the code layout on the same route and recorded on the issue.
- Depends on: T7, T8.

**T10. publish, versions, reset**
- Scope: section 8.2 (flush, validate, `PublishSiteDesignTx`, release, versions), section 9
  (reset, keep editing, start over, delete), discard, restore per item (rule 9 for templates),
  history routes, activity.
- Acceptance: one release per publish, with versions only for changed items; a failed flush
  publishes nothing; an empty template or an unresolved part is refused with what failed,
  and failing contrast pairs need `confirm_contrast`; reset publishes NULL and a restore brings it back; restore goes
  through the editor (relay test, `liveRestore` pattern); nothing in the transaction waits on
  a network call.
- Depends on: T3, T8.

**T11. admin: Site editor**
- Scope: section 13 items 1, 3, 4, 5, 6, 8, 9, 11, per T1's boards: overview, template and
  part editors (the bound editor with the Site group, the part card, query settings), publish
  dialog, reset, history, presence; rules in `lib/siteDesign.ts` (tested).
- Acceptance: the overview says what renders each route; "Changes not published" per item
  and in total; the editor offers site blocks only here; the part card opens the part; the
  preview reloads on `stored`; keyboard and screen reader paths as for the post editor.
- Depends on: T1, T4, T9, T10.

**T12. builder page templates (#336)**
- Scope: section 10: `custom-<name>` templates, the widened CHECK, `PUT /posts/:id/template`,
  `pageLayoutVariant`'s branch, the Template field's list, the `front-page` slug.
- Acceptance: a page with a builder template renders it once published and Updated; an
  unpublished or deleted one renders the default and keeps the name; versions restore the
  name; the Pages list's Template column shows builder templates.
- Depends on: T9, T10.

**T13. caching hooks**
- Scope: section 11: cache-aside for the resolve and styles reads; the purge on every event
  listed there; the preview bypass.
- Acceptance: a publish is visible on the next request after the purge; a previewed page is
  never stored by the cache (integration test with #185's implementation); no purge fires
  inside a transaction.
- Depends on: #185, T10.

**T14. media "Used in" for templates and parts**
- Scope: `site_template_media` sync on store and publish; `GET /media/:id/posts`'s
  `site_templates`; the delete confirmation; the logo's "Site logo" entry.
- Acceptance: a media item used in a part lists it; deleting asks first and names it; the
  part then renders without the block (`media_missing`).
- Depends on: T8.

**T15. export as a theme package**
- Scope: section 14, once #332 defines packages and child themes resolve. The package is
  data-only, so it activates without the site build.
- Acceptance: an exported package installed on a fresh site renders the same pages as the
  source site's published design, with no site build; its templates appear as theme
  defaults there.
- Depends on: #332's data-only packages, child-theme resolution. Not S12.

**T16. site blocks III**
- Scope: `related_posts`, `author_cards`, `table_of_contents`, `color_scheme_switch`, and
  `readingTime` on `post_byline` (4.1), with the same chain as T6.
- Acceptance: each renders the markup of the default theme's component it replaces
  (`RelatedPosts`, `AuthorCards`, `TableOfContents`, `ThemeSwitch`); the switch works
  without inline script (`theme-init.js`'s CSP rule); the fingerprint test pins the change.
- Depends on: T7.

**T17. default theme as block templates**
- Scope: 5.7's decision: `templates/*.json` and `parts/*.json` for every route, header and
  footer; post variants as block templates; the `.astro` layouts removed except
  `layouts/error`; the default theme's templates become the starters.
- Acceptance: first, the variant mapping is settled on the issue; every route kind renders
  as before on `theme.astro.test.ts`'s fixtures, with listed and approved differences only;
  the 500 page renders with the API down; Customize on the default theme starts from what
  readers see; `tokens.test.ts` and the block style tests still pass.
- Depends on: T9, T16.

**T18. comments site block**
- Scope: a `comments` site block over the reader-comments feature, for `single` and `page`
  templates.
- Acceptance: settled with the reader-comments design.
- Depends on: the reader-comments issue, T7.

---

## 16. Decisions and open questions

Questions 1, 4, 6, 7, 8 and 9 were decided on review (2026-11-13). The others keep the
working answer this design assumes until someone raises them.

1. **Contrast at publish. Decided: warn and allow.** Publishing with a failing pair needs an
   explicit confirmation naming the pairs (6.3, 8.2).
2. **Phones.** Editing templates and styles is desktop-only in v1 (assumed). A phone editing
   path could come later.
3. **Custom CSS.** Not offered (assumed). WordPress has "Additional CSS". If wanted, it needs
   its own sanitizer and would be the only free-form CSS on the site.
4. **Navigation by location or by menu. Decided: both.** The block takes a theme menu
   location or any menu by id (4.1). A menu by id reaches the page through the resolve
   route only, never through a public route that serves any menu.
5. **Query loop in posts.** Inert in v1 (assumed). Allowing it later needs no new data path.
6. **Customizations and theme switches. Decided: per theme.** Switching themes shows that
   theme's own design, and switching back brings the earlier one back. There is no copy
   across in v1.
7. **The default theme as block templates. Decided: convert it** (5.7, T16, T17), after the
   builder's rendering lands.
8. **Data-only theme packages. Decided: activate without a site build** (section 14). This
   goes to #332 as a scope note.
9. **Reader comments. Decided: planned.** They get their own issue and design, and the
   comments block (T18) follows them.
10. **Who edits templates.** Admins only (assumed, from the issue). Editors could be given
    template parts later, without the publish.
