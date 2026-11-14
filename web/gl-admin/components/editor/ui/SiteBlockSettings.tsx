import { useEffect, useId, useState } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import {
  normalizeSiteBlockAttrs,
  normalizeSiteLogoWidth,
  SEARCH_BUTTON_MAX_LENGTH,
  SEARCH_LABEL_MAX_LENGTH,
  SEARCH_PLACEHOLDER_MAX_LENGTH,
  SITE_LOGO_MAX_WIDTH,
  SITE_LOGO_MIN_WIDTH,
  siteBlockTypeOfNode,
  type SiteBlockType,
} from "@gl-admin/lib/blocks-spec"
import { listMenus, type Menu, type MenuLocation } from "@gl-admin/lib/api/menus"
import { getActiveTheme } from "@gl-admin/lib/api/themes"
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
    default:
      return null
  }
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
      {type === "site_logo" && (
        <div className="post-settings__field">
          <label className="post-settings__label" htmlFor={`${ids}-width`}>
            Width
          </label>
          <input
            id={`${ids}-width`}
            type="number"
            min={SITE_LOGO_MIN_WIDTH}
            max={SITE_LOGO_MAX_WIDTH}
            step={1}
            value={Number(attrs.width) || ""}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              if (Number.isFinite(value)) set({ width: normalizeSiteLogoWidth(value) })
            }}
          />
          <small className="post-settings__hint">
            In pixels, {SITE_LOGO_MIN_WIDTH} to {SITE_LOGO_MAX_WIDTH}. The height follows the image.
          </small>
        </div>
      )}
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
      {hint && <p className="post-settings__hint">{hint}</p>}
    </fieldset>
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
