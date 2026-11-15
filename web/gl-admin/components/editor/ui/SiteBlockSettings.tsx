import { useEffect, useId, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import {
  normalizeSiteBlockAttrs,
  normalizeSiteLogoWidth,
  SEARCH_BUTTON_MAX_LENGTH,
  SEARCH_LABEL_MAX_LENGTH,
  SEARCH_PLACEHOLDER_MAX_LENGTH,
  SITE_LOGO_DEFAULT_WIDTH,
  SITE_LOGO_MAX_WIDTH,
  SITE_LOGO_MIN_WIDTH,
  siteBlockTypeOfNode,
  normalizePostExcerptLength,
  normalizeQueryPerPage,
  POST_DATE_FORMATS,
  POST_DATE_WHICH,
  POST_EXCERPT_DEFAULT_WORDS,
  POST_EXCERPT_MAX_WORDS,
  POST_EXCERPT_MIN_WORDS,
  POST_FEATURED_IMAGE_ASPECTS,
  POST_TERMS_DEFAULT_TAXONOMY,
  QUERY_DEFAULT_PER_PAGE,
  QUERY_DEFAULT_POST_TYPE,
  QUERY_MAX_PER_PAGE,
  QUERY_MIN_PER_PAGE,
  type PostFeaturedImageAspect,
  type QueryAttrs,
  type SiteBlockType,
} from "@gl-admin/lib/blocks-spec"
import { listMenus, type Menu, type MenuLocation } from "@gl-admin/lib/api/menus"
import { getActiveTheme } from "@gl-admin/lib/api/themes"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import { getAllTaxonomyTerms, getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import { getCreditedAuthors, type CreditedAuthor } from "@gl-admin/lib/api/posts"
import type { PostType, TaxonomyTerm } from "@gl-admin/lib/api/types"
import Switch from "../../ui/Switch"
import Segment from "./BlockSettingsSegment"
import { keepBlockSelected, resolveEditorBlock, type BlockRef } from "../utils/blockTree"
import { partName } from "../extensions/SiteBlockViews"

// The settings panel's Block tab for the site blocks (#488, the blocks canvas's "Site blocks
// in the editor" settings column). Each change is one `setNodeMarkup` on the block found by
// its id when it's made, last writer wins; the bridge normalizes what's stored
// (`normalizeSiteBlockAttrs`). No plugin, no appendTransaction (rule 7).

export const SITE_TITLE_LEVEL_HELP = "Use H1 only where the page has no title of its own, such as Home."
export const SITE_IDENTITY_HELP = "The name is the site’s, edited in Settings › General. The block only sets how it shows."
export const SITE_LOGO_HELP = "The logo is the site’s, chosen in Settings › General. Without one the block shows nothing."
export const SEARCH_LABEL_HELP = "Read by screen readers; not shown."
export const NAVIGATION_HELP = "A theme location follows whichever menu is assigned to it. A menu shows that menu wherever the theme is."
/** The parts every site has (design 5.7: core's starters), plus the one a block names. */
const KNOWN_PARTS = ["header", "footer"] as const

const LEVELS = ["0", "1", "2"] as const
const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = { "0": "Paragraph", "1": "H1", "2": "H2" }
const LAYOUTS = ["row", "column"] as const
const LAYOUT_LABELS: Record<(typeof LAYOUTS)[number], string> = { row: "Row", column: "Column" }

function setSiteAttrs(editor: TiptapEditor, ref: BlockRef, attrs: Record<string, unknown>) {
  if (!editor.isEditable) return
  const block = resolveEditorBlock(editor.state.doc, ref)
  if (!block) return
  if (Object.entries(attrs).every(([key, value]) => block.node.attrs[key] === value)) return
  editor.view.dispatch(keepBlockSelected(editor.state, block.pos, editor.state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, ...attrs })))
}

export function siteBlockHint(type: SiteBlockType): string | null {
  switch (type) {
    case "site_title":
    case "site_tagline":
      return SITE_IDENTITY_HELP
    case "site_logo":
      return SITE_LOGO_HELP
    case "query_pagination":
      return QUERY_PAGINATION_HELP
    case "post_template":
      return POST_TEMPLATE_HELP
    case "query_no_results":
      return QUERY_NO_RESULTS_HELP
    case "post_content":
      return POST_CONTENT_HELP
    case "query_title":
    case "term_description":
      return QUERY_TITLE_HELP
    case "post_navigation":
      return POST_NAVIGATION_HELP
    default:
      return null
  }
}

// #489, the canvas's query loop and post blocks rows.
export const QUERY_PUBLISHED_HELP = "Published posts only, as readers see them."
export const QUERY_INHERIT_HELP = "For archive, search and home templates: the page’s own posts, with its pages."
export const QUERY_PAGINATION_HELP = "Only the page’s own list has pages. Under a query of chosen posts it shows nothing."
export const POST_TEMPLATE_HELP = "Repeats for each post of its query loop. Its post blocks show that post."
export const QUERY_NO_RESULTS_HELP = "Shows its blocks when the query loop finds no posts."
export const POST_CONTENT_HELP = "The post’s blocks render here, with their own anchors. Once per template, never in a part or a post template."
export const QUERY_TITLE_HELP = "On the page: the category or tag, “Posts by …”, “Search results for …”, or the post type’s name."
export const POST_NAVIGATION_HELP = "Links to the post before and after this one. The newest links back to its list."
export const POST_TITLE_HELP = "“Sized for the page” is an H1 for the page’s post and an H3 in a post template, which links to the post."

const QUERY_TITLE_LEVEL_VALUES = ["1", "2"] as const
const QUERY_TITLE_LEVEL_LABELS: Record<(typeof QUERY_TITLE_LEVEL_VALUES)[number], string> = { "1": "H1", "2": "H2" }
const POST_TITLE_LEVEL_VALUES = ["auto", "1", "2", "3", "4"] as const
const POST_TITLE_LEVEL_LABELS: Record<(typeof POST_TITLE_LEVEL_VALUES)[number], string> = { auto: "Auto", "1": "H1", "2": "H2", "3": "H3", "4": "H4" }
const POST_TITLE_LINK_VALUES = ["auto", "link", "none"] as const
const POST_TITLE_LINK_LABELS: Record<(typeof POST_TITLE_LINK_VALUES)[number], string> = { auto: "Auto", link: "Link", none: "No link" }
const ASPECT_LABELS: Record<PostFeaturedImageAspect, string> = { auto: "Original", "16-9": "16:9", "3-2": "3:2", "1-1": "1:1" }
const DATE_WHICH_LABELS: Record<(typeof POST_DATE_WHICH)[number], string> = { published: "Published", modified: "Updated" }
const DATE_FORMAT_LABELS: Record<(typeof POST_DATE_FORMATS)[number], string> = { long: "Long", short: "Short" }
const ORDER_BYS = ["date", "title"] as const
const ORDER_BY_LABELS: Record<(typeof ORDER_BYS)[number], string> = { date: "Date", title: "Title" }
const ORDERS = ["desc", "asc"] as const

/** The order's words, which depend on what it orders by ("Newest first", "A to Z"). */
export function orderLabels(orderBy: "date" | "title"): Record<(typeof ORDERS)[number], string> {
  return orderBy === "title" ? { asc: "A to Z", desc: "Z to A" } : { desc: "Newest first", asc: "Oldest first" }
}

/**
 * A whole number typed freely and stored on Enter or when the field loses focus, through
 * `normalize` (the logo's width, an excerpt's length): clamping each keystroke would turn
 * the "1" of "12" into the minimum.
 */
export function NumberField({
  id,
  label,
  value,
  fallback,
  min,
  max,
  hint,
  normalize,
  onCommit,
}: {
  id: string
  label: string
  value: unknown
  fallback: number
  min: number
  max: number
  hint: string
  normalize: (value: number) => number
  onCommit: (value: number) => void
}) {
  const stored = typeof value === "number" && Number.isFinite(value) ? value : fallback
  const [text, setText] = useState(String(stored))
  useEffect(() => setText(String(stored)), [stored])
  const commit = () => {
    const typed = Number(text)
    if (text.trim() === "" || !Number.isFinite(typed)) {
      setText(String(stored))
      return
    }
    const next = normalize(typed)
    setText(String(next))
    if (next !== stored) onCommit(next)
  }
  return (
    <div className="post-settings__field">
      <label className="post-settings__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={1}
        value={text}
        aria-describedby={`${id}-hint`}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          commit()
        }}
      />
      <small id={`${id}-hint`} className="post-settings__hint">
        {hint}
      </small>
    </div>
  )
}

/** The public post types, categories and members who are credited somewhere, read when the panel opens; a failed read lists none. */
function useQueryChoices(postType: string) {
  const [lists, setLists] = useState<{ types: PostType[]; categories: TaxonomyTerm[] }>({ types: [], categories: [] })
  const [authors, setAuthors] = useState<CreditedAuthor[]>([])
  // The types and categories once per panel; only who is credited depends on the type.
  useEffect(() => {
    let live = true
    void Promise.all([
      getPostTypes()
        .then((page) => page.data)
        .catch(() => [] as PostType[]),
      getAllTaxonomyTerms("category").catch(() => [] as TaxonomyTerm[]),
    ]).then(([types, categories]) => {
      if (live) setLists({ types: types.filter((t) => t.is_active !== false && t.public !== false), categories })
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    let live = true
    void getCreditedAuthors({ type: postType })
      .catch(() => [] as CreditedAuthor[])
      .then((found) => live && setAuthors(found))
    return () => {
      live = false
    }
  }, [postType])
  return { ...lists, authors }
}

/**
 * A query's settings (#489, the canvas's "Query loop" settings column): "Use this page’s list",
 * or the type, count, order, category and author. Each one change, last writer wins; the store
 * keeps them through `normalizeSiteBlockAttrs`.
 */
function QueryFields({ ids, attrs, set }: { ids: string; attrs: Record<string, unknown>; set: (attrs: Record<string, unknown>) => void }) {
  const stored = normalizeSiteBlockAttrs("query", attrs) as QueryAttrs
  const postType = stored.postType ?? QUERY_DEFAULT_POST_TYPE
  const { types, categories, authors } = useQueryChoices(postType)
  const orderBy = stored.orderBy === "title" ? "title" : "date"
  const category = stored.taxonomy === "category" && stored.termIds?.length === 1 ? String(stored.termIds[0]) : ""
  const typeOptions = types.some((t) => t.name === postType) ? types : [...types, { name: postType, label: postType } as PostType]
  return (
    <>
      <Switch className="block-settings__switch" label="Use this page’s list" checked={stored.inherit === true} onChange={(inherit) => set({ inherit })} />
      <p className="post-settings__hint">{QUERY_INHERIT_HELP}</p>
      {stored.inherit !== true && (
        <>
          <div className="post-settings__field">
            <label className="post-settings__label" htmlFor={`${ids}-type`}>
              Post type
            </label>
            <select id={`${ids}-type`} value={postType} onChange={(event) => set({ postType: event.currentTarget.value })}>
              {typeOptions.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label || t.name}
                </option>
              ))}
            </select>
          </div>
          <NumberField
            id={`${ids}-count`}
            label="Posts per page"
            value={stored.perPage}
            fallback={QUERY_DEFAULT_PER_PAGE}
            min={QUERY_MIN_PER_PAGE}
            max={QUERY_MAX_PER_PAGE}
            hint={`${QUERY_MIN_PER_PAGE} to ${QUERY_MAX_PER_PAGE}.`}
            normalize={normalizeQueryPerPage}
            onCommit={(perPage) => set({ perPage })}
          />
          <Segment label="Order by" values={ORDER_BYS} labels={ORDER_BY_LABELS} value={orderBy} onPick={(next) => set({ orderBy: next })} />
          <Segment label="Order" values={ORDERS} labels={orderLabels(orderBy)} value={stored.order === "asc" ? "asc" : "desc"} onPick={(order) => set({ order })} />
          <div className="post-settings__field">
            <label className="post-settings__label" htmlFor={`${ids}-category`}>
              Category
            </label>
            <select
              id={`${ids}-category`}
              value={category}
              onChange={(event) => {
                const id = event.currentTarget.value
                // The taxonomy and its terms in one change, so neither is ever left without the other.
                set(id ? { taxonomy: "category", termIds: id } : { taxonomy: null, termIds: null })
              }}
            >
              <option value="">Any</option>
              {categories.map((term) => (
                <option key={term.id} value={String(term.id)}>
                  {term.name}
                </option>
              ))}
              {category && !categories.some((term) => String(term.id) === category) && <option value={category}>{`Category ${category}`}</option>}
            </select>
          </div>
          <div className="post-settings__field">
            <label className="post-settings__label" htmlFor={`${ids}-author`}>
              Author
            </label>
            <select id={`${ids}-author`} value={stored.authorId ? String(stored.authorId) : ""} onChange={(event) => set({ authorId: event.currentTarget.value ? Number(event.currentTarget.value) : null })}>
              <option value="">Anyone</option>
              {authors.map((author) => (
                <option key={author.id} value={String(author.id)}>
                  {author.full_name || author.username}
                </option>
              ))}
              {stored.authorId && !authors.some((author) => author.id === stored.authorId) && <option value={String(stored.authorId)}>{`Member ${stored.authorId}`}</option>}
            </select>
          </div>
        </>
      )}
      <p className="post-settings__hint">{QUERY_PUBLISHED_HELP}</p>
    </>
  )
}

/** The taxonomies a `post_terms` block may show, read when the panel opens; a failed read lists only the current one. */
function TaxonomyField({ id, taxonomy, onPick }: { id: string; taxonomy: unknown; onPick: (taxonomy: string) => void }) {
  const current = typeof taxonomy === "string" && taxonomy ? taxonomy : POST_TERMS_DEFAULT_TAXONOMY
  const [types, setTypes] = useState<{ name: string; label: string }[]>([])
  useEffect(() => {
    let live = true
    getTaxonomyTypes()
      .then((page) => live && setTypes(page.data.filter((t) => t.public !== false).map((t) => ({ name: t.name, label: t.label || t.name }))))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const options = types.some((t) => t.name === current) ? types : [...types, { name: current, label: current === POST_TERMS_DEFAULT_TAXONOMY ? "Category" : current }]
  return (
    <div className="post-settings__field">
      <label className="post-settings__label" htmlFor={id}>
        Taxonomy
      </label>
      <select id={id} value={current} onChange={(event) => onPick(event.currentTarget.value)}>
        {options.map((t) => (
          <option key={t.name} value={t.name}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function SiteBlockSettings({ editor, node, blockRef }: { editor: TiptapEditor; node: PMNode; blockRef: BlockRef }) {
  const type = siteBlockTypeOfNode(node.type.name)
  const ids = useId()
  if (!type) return null
  const attrs = node.attrs
  const set = (next: Record<string, unknown>) => setSiteAttrs(editor, blockRef, next)
  const hint = siteBlockHint(type)

  return (
    <fieldset className="post-settings__fieldset" disabled={!editor.isEditable}>
      {type === "site_title" && (
        <>
          <Segment
            label="Level"
            values={LEVELS}
            labels={LEVEL_LABELS}
            value={String(normalizeSiteBlockAttrs("site_title", attrs).level ?? 0) as (typeof LEVELS)[number]}
            onPick={(value) => set({ level: Number(value) })}
          />
          <p className="post-settings__hint">{SITE_TITLE_LEVEL_HELP}</p>
        </>
      )}
      {type === "site_logo" && <WidthField id={`${ids}-width`} width={attrs.width} onCommit={(width) => set({ width })} />}
      {(type === "site_title" || type === "site_logo") && (
        <Switch className="block-settings__switch" label="Link to the home page" checked={attrs.link !== false} onChange={(link) => set({ link })} />
      )}
      {type === "navigation" && <NavigationFields ids={ids} attrs={attrs} set={set} />}
      {type === "search" && (
        <>
          <TextField id={`${ids}-label`} label="Label" value={attrs.label} max={SEARCH_LABEL_MAX_LENGTH} placeholder="Search" hint={SEARCH_LABEL_HELP} onChange={(label) => set({ label })} />
          <TextField id={`${ids}-placeholder`} label="Placeholder" value={attrs.placeholder} max={SEARCH_PLACEHOLDER_MAX_LENGTH} onChange={(placeholder) => set({ placeholder })} />
          <TextField
            id={`${ids}-button`}
            label="Button"
            value={attrs.button}
            max={SEARCH_BUTTON_MAX_LENGTH}
            placeholder="Search"
            hint={`Up to ${SEARCH_BUTTON_MAX_LENGTH} characters.`}
            onChange={(button) => set({ button })}
          />
        </>
      )}
      {type === "template_part" && <PartField id={`${ids}-part`} slug={attrs.slug} onPick={(slug) => set({ slug })} />}
      {type === "query" && <QueryFields ids={ids} attrs={attrs} set={set} />}
      {type === "query_title" && (
        <Segment label="Level" values={QUERY_TITLE_LEVEL_VALUES} labels={QUERY_TITLE_LEVEL_LABELS} value={attrs.level === 2 ? "2" : "1"} onPick={(level) => set({ level: Number(level) })} />
      )}
      {type === "post_title" && (
        <>
          <Segment
            label="Level"
            values={POST_TITLE_LEVEL_VALUES}
            labels={POST_TITLE_LEVEL_LABELS}
            value={(typeof attrs.level === "number" ? String(attrs.level) : "auto") as (typeof POST_TITLE_LEVEL_VALUES)[number]}
            onPick={(level) => set({ level: level === "auto" ? null : Number(level) })}
          />
          <Segment
            label="Link"
            values={POST_TITLE_LINK_VALUES}
            labels={POST_TITLE_LINK_LABELS}
            value={attrs.link === true ? "link" : attrs.link === false ? "none" : "auto"}
            onPick={(link) => set({ link: link === "auto" ? null : link === "link" })}
          />
          <p className="post-settings__hint">{POST_TITLE_HELP}</p>
        </>
      )}
      {type === "post_excerpt" && (
        <NumberField
          id={`${ids}-length`}
          label="Length"
          value={attrs.length}
          fallback={POST_EXCERPT_DEFAULT_WORDS}
          min={POST_EXCERPT_MIN_WORDS}
          max={POST_EXCERPT_MAX_WORDS}
          hint={`In words, ${POST_EXCERPT_MIN_WORDS} to ${POST_EXCERPT_MAX_WORDS}.`}
          normalize={normalizePostExcerptLength}
          onCommit={(length) => set({ length })}
        />
      )}
      {type === "post_featured_image" && (
        <>
          <Segment label="Shape" values={POST_FEATURED_IMAGE_ASPECTS} labels={ASPECT_LABELS} value={(attrs.aspect as PostFeaturedImageAspect) ?? "auto"} onPick={(aspect) => set({ aspect })} />
          <p className="post-settings__hint">Cropped around the image’s focal point.</p>
          <Switch className="block-settings__switch" label="Link to the post" checked={attrs.link === true} onChange={(link) => set({ link })} />
          <p className="post-settings__hint">A post without one shows nothing here.</p>
        </>
      )}
      {type === "post_date" && (
        <>
          <Segment label="Date" values={POST_DATE_WHICH} labels={DATE_WHICH_LABELS} value={attrs.which === "modified" ? "modified" : "published"} onPick={(which) => set({ which })} />
          <Segment label="Format" values={POST_DATE_FORMATS} labels={DATE_FORMAT_LABELS} value={attrs.format === "short" ? "short" : "long"} onPick={(format) => set({ format })} />
          <p className="post-settings__hint">In the site’s date format, from Settings › General.</p>
        </>
      )}
      {type === "post_byline" && <Switch className="block-settings__switch" label="Show avatars" checked={attrs.avatars !== false} onChange={(avatars) => set({ avatars })} />}
      {type === "post_terms" && <TaxonomyField id={`${ids}-taxonomy`} taxonomy={attrs.taxonomy} onPick={(taxonomy) => set({ taxonomy })} />}
      {hint && <p className="post-settings__hint">{hint}</p>}
    </fieldset>
  )
}

/**
 * The logo's width (a NumberField), typed freely and stored on Enter or when the field loses focus, clamped
 * then: clamping each keystroke would turn the "1" of "120" into 32.
 */
export function WidthField({ id, width, onCommit }: { id: string; width: unknown; onCommit: (width: number) => void }) {
  return (
    <NumberField
      id={id}
      label="Width"
      value={Number(width) || SITE_LOGO_DEFAULT_WIDTH}
      fallback={SITE_LOGO_DEFAULT_WIDTH}
      min={SITE_LOGO_MIN_WIDTH}
      max={SITE_LOGO_MAX_WIDTH}
      hint={`In pixels, ${SITE_LOGO_MIN_WIDTH} to ${SITE_LOGO_MAX_WIDTH}. The height follows the image.`}
      normalize={normalizeSiteLogoWidth}
      onCommit={onCommit}
    />
  )
}

function TextField({
  id,
  label,
  value,
  max,
  placeholder,
  hint,
  onChange,
}: {
  id: string
  label: string
  value: unknown
  max: number
  placeholder?: string
  hint?: string
  onChange: (value: string | null) => void
}) {
  return (
    <div className="post-settings__field">
      <label className="post-settings__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        maxLength={max * 2}
        value={typeof value === "string" ? value : ""}
        placeholder={placeholder}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.currentTarget.value === "" ? null : event.currentTarget.value)}
      />
      {hint && (
        <small id={`${id}-hint`} className="post-settings__hint">
          {hint}
        </small>
      )}
    </div>
  )
}

function PartField({ id, slug, onPick }: { id: string; slug: unknown; onPick: (slug: string) => void }) {
  const current = typeof slug === "string" && slug ? slug : ""
  const options = [...new Set<string>([...KNOWN_PARTS, ...(current ? [current] : [])])]
  return (
    <div className="post-settings__field">
      <label className="post-settings__label" htmlFor={id}>
        Part
      </label>
      <select id={id} value={current} onChange={(event) => event.currentTarget.value && onPick(event.currentTarget.value)}>
        {!current && <option value="">Choose a part</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {partName(option)}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The locations of the active theme and every menu, read when the panel opens; a failed read lists none. */
function useMenuChoices() {
  const [choices, setChoices] = useState<{ locations: MenuLocation[]; menus: Menu[] }>({ locations: [], menus: [] })
  useEffect(() => {
    let live = true
    void Promise.all([
      getActiveTheme().catch(() => null),
      listMenus().catch(() => [] as Menu[]),
    ]).then(([theme, menus]) => {
      if (!live) return
      const locations = ((theme?.config as { menu_locations?: MenuLocation[] } | undefined)?.menu_locations ?? []).filter(
        (location) => typeof location?.name === "string"
      )
      setChoices({ locations, menus })
    })
    return () => {
      live = false
    }
  }, [])
  return choices
}

function NavigationFields({ ids, attrs, set }: { ids: string; attrs: Record<string, unknown>; set: (attrs: Record<string, unknown>) => void }) {
  const { locations, menus } = useMenuChoices()
  const stored = normalizeSiteBlockAttrs("navigation", attrs)
  const value = stored.menuId !== undefined ? `menu:${stored.menuId}` : stored.location !== undefined ? `location:${stored.location}` : ""
  const knownLocation = locations.some((location) => `location:${location.name}` === value)
  const knownMenu = menus.some((menu) => `menu:${menu.id}` === value)
  return (
    <>
      <div className="post-settings__field">
        <label className="post-settings__label" htmlFor={`${ids}-menu`}>
          Menu
        </label>
        <select
          id={`${ids}-menu`}
          value={value}
          aria-describedby={`${ids}-menu-hint`}
          onChange={(event) => {
            const [kind, name] = event.currentTarget.value.split(/:(.*)/s)
            // One or the other, in one change: picking a location clears the menu, and back.
            if (kind === "location") set({ location: name, menuId: null })
            else if (kind === "menu") set({ menuId: Number(name), location: null })
          }}
        >
          {value === "" && <option value="">Choose a menu</option>}
          <optgroup label="Theme locations">
            {locations.map((location) => (
              <option key={location.name} value={`location:${location.name}`}>
                {location.label || location.name}
              </option>
            ))}
            {stored.location !== undefined && !knownLocation && <option value={value}>{String(stored.location)}</option>}
          </optgroup>
          <optgroup label="Menus">
            {menus.map((menu) => (
              <option key={menu.id} value={`menu:${menu.id}`}>
                {menu.name}
              </option>
            ))}
            {stored.menuId !== undefined && !knownMenu && <option value={value}>{`Menu ${stored.menuId}`}</option>}
          </optgroup>
        </select>
        <small id={`${ids}-menu-hint`} className="post-settings__hint">
          {NAVIGATION_HELP}
        </small>
      </div>
      <Segment label="Layout" values={LAYOUTS} labels={LAYOUT_LABELS} value={stored.layout === "column" ? "column" : "row"} onPick={(layout) => set({ layout })} />
      <Switch
        className="block-settings__switch"
        label="Fold into a menu button on phones"
        checked={stored.overlay !== "never"}
        onChange={(fold) => set({ overlay: fold ? "phone" : "never" })}
      />
    </>
  )
}
