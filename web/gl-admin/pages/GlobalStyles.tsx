import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import Button, { buttonClassName } from "@gl-admin/components/ui/Button"
import Pill from "@gl-admin/components/ui/Pill"
import Select from "@gl-admin/components/ui/Select"
import Modal from "@gl-admin/components/ui/Modal"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import { FieldMessage, describedBy } from "@gl-admin/components/ui/Input"
import { CheckIcon, ChevronRightIcon, DangerIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import StylesPreview from "@gl-admin/components/site-editor/StylesPreview"
import PublishDesignDialog from "@gl-admin/components/site-editor/PublishDesignDialog"
import { useStylesDraft, type SaveState } from "@gl-admin/components/site-editor/useStylesDraft"
import { MOBILE_QUERY } from "@gl-admin/components/sidebar/Sidebar"
import { useMediaQuery } from "@gl-admin/lib/hooks/useMediaQuery"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import { getGlobalStyles, type GlobalStylesResponse } from "@gl-admin/lib/api/siteDesign"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { normalizeColor } from "@/lib/globalStyles"
import {
  STYLE_GROUPS,
  contrastSummary,
  draftFromOverrides,
  fieldText,
  fontChoices,
  fontStack,
  formatMinimum,
  formatRatio,
  groupChanged,
  passCount,
  resetGroup,
  setOverride,
  styleGroup,
  type ColorRow,
  type ContrastSummary,
  type Overrides,
  type PairResult,
  type StyleField,
  type StyleForm,
  type StyleGroupId,
} from "@gl-admin/lib/globalStyles"
import "@gl-admin/assets/styles/pages/global-styles.scss"

// Site editor › Global styles (#487; docs/design/theme-builder.md 6, 8.3, 9 and 13, the
// redesign canvas's "Site editor · global styles" board): the active theme's colours with
// light and dark side by side and their contrast, fonts, the type scale, layout widths,
// spacing and radius, each group with its Reset, and the preview frame. A form, not a
// shared document: it saves as you go (useStylesDraft). The rules are lib/globalStyles.ts.
//
// Hidden until their issues: the Site editor overview and its sidebar entry (#493), so the
// breadcrumb's "Site editor" is plain text and the way back is Themes; the publish of
// templates and parts (#492: publishSiteDesign is the one call it swaps); History.

const SECTION_ID: Record<StyleGroupId, string> = {
  colors: "gl-styles-colors",
  blockColors: "gl-styles-block-colors",
  fonts: "gl-styles-fonts",
  typeScale: "gl-styles-type-scale",
  layout: "gl-styles-layout",
  spacingRadius: "gl-styles-spacing",
}

export default function GlobalStylesPage() {
  usePageTitle("Global styles")
  const isPhone = useMediaQuery(MOBILE_QUERY)
  const [loaded, setLoaded] = useState<GlobalStylesResponse | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setLoaded(await getGlobalStyles())
    } catch (error) {
      setLoadError(error)
    }
  }, [])

  // Nothing to read at phone width (the screen only asks for a larger one); widening the
  // window loads it then.
  useEffect(() => {
    if (!isPhone && !loaded) void load()
  }, [load, isPhone, loaded])

  if (isPhone) {
    return (
      <div className="gl-styles gl-styles--message">
        <h1 className="gl-visually-hidden">Global styles</h1>
        <EmptyState
          title="Use a larger screen to edit styles"
          description="The editor needs room for the form and the preview side by side."
          action={<BackLink />}
        />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="gl-styles gl-styles--message">
        <h1 className="gl-visually-hidden">Global styles</h1>
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load the styles"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!loaded) return <LoadingStyles />

  if (!loaded.supported) {
    return (
      <div className="gl-styles gl-styles--message">
        <h1 className="gl-visually-hidden">Global styles</h1>
        <EmptyState
          title={`${loaded.theme.name} doesn't support global styles`}
          description="Its colours and fonts are set in its code."
          action={<BackLink />}
        />
      </div>
    )
  }

  return <StylesEditor initial={loaded} />
}

function BackLink() {
  return (
    <Link to="/themes" className={buttonClassName("secondary", "lg")}>
      <span className="gl-button__label">Back to Themes</span>
    </Link>
  )
}

function LoadingStyles() {
  return (
    <div className="gl-styles" aria-busy="true">
      <h1 className="gl-visually-hidden">Global styles</h1>
      <div className="gl-styles__topbar">
        <Skeleton width={180} height={20} />
      </div>
      <div className="gl-styles__body">
        <div className="gl-styles__form">
          <Skeleton width={120} height={18} />
          {[160, 200, 180, 210, 170].map((width, i) => (
            <div key={i} className="gl-styles__skeleton-row">
              <Skeleton width={140} height={12} />
              <Skeleton width={width} height={32} />
              <Skeleton width={width} height={32} />
            </div>
          ))}
        </div>
        <div className="gl-styles-preview">
          <Skeleton height={560} />
        </div>
      </div>
    </div>
  )
}

// ---- The editor ----

function StylesEditor({ initial }: { initial: GlobalStylesResponse }) {
  const [previewKey, setPreviewKey] = useState(0)
  const draft = useStylesDraft(initial, { onSaved: () => setPreviewKey((key) => key + 1) })
  const { server, form, overrides, errors, change, commit, saveState } = draft
  const [resetAllOpen, setResetAllOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [unsavedNote, setUnsavedNote] = useState<string | null>(null)
  const [blockColorsOpen, setBlockColorsOpen] = useState(false)
  const themeName = server.theme.name

  // Contrast follows the fields as they're typed (only valid colours count).
  const contrast = useMemo(
    () => contrastSummary(draft.theme, draftFromOverrides(form, overrides)),
    [draft.theme, form, overrides]
  )

  useLeaveWarning(saveState)

  const edit = (field: StyleField, text: string) =>
    change(setOverride(form, overrides, field.path, text), { kind: "field", path: field.path, text })
  const pick = (field: StyleField, value: string) =>
    change(
      setOverride(form, overrides, field.path, value),
      { kind: "field", path: field.path, text: value },
      { now: true }
    )
  const reset = (id: StyleGroupId) => change(resetGroup(overrides, id), { kind: "reset", group: id }, { now: true })
  const resetAll = () => {
    setResetAllOpen(false)
    change({}, { kind: "reset", group: "all" }, { now: true })
  }

  const openPublish = async () => {
    // What the dialog publishes is what's saved: save the latest change (and drop values
    // the theme no longer declares, which publish would refuse) first.
    const saved = await draft.flush({ force: true })
    setUnsavedNote(saved ? null : "A value in the form can't be saved yet, or the last save failed.")
    setPublishOpen(true)
  }

  const fieldProps = (field: StyleField) => ({
    field,
    text: fieldText(field, overrides),
    error: errors[field.path],
    changed: Object.prototype.hasOwnProperty.call(overrides, field.path),
    onChange: (text: string) => edit(field, text),
    onCommit: commit,
  })

  const jumpTo = (id: StyleGroupId) => {
    if (id === "blockColors") setBlockColorsOpen(true)
    const heading = document.getElementById(`${SECTION_ID[id]}-h`)
    heading?.scrollIntoView?.({ block: "start", behavior: "smooth" })
    heading?.focus({ preventScroll: true })
  }

  // Styles are one item of the release (#492 adds templates and parts): it counts while it
  // differs from the published copy, or while a change of it is still being saved.
  const publishCount = server.has_unpublished_changes || draft.unsaved ? 1 : 0

  return (
    <div className="gl-styles">
      <h1 className="gl-visually-hidden">Global styles</h1>
      <header className="gl-styles__topbar">
        <nav className="gl-styles__crumb" aria-label="Breadcrumb">
          <ol>
            <li>Site editor</li>
            <li aria-current="page">Global styles</li>
          </ol>
        </nav>
        {server.has_unpublished_changes && <Pill tone="accent">Changes not published</Pill>}
        <span className="gl-styles__spacer" />
        <SaveStatus state={saveState} error={draft.saveError} onRetry={() => void draft.flush()} />
        <Button
          variant="secondary"
          onClick={() => setResetAllOpen(true)}
          disabled={Object.keys(overrides).length === 0}
        >
          Reset all…
        </Button>
        <Button
          variant="primary"
          onClick={() => void openPublish()}
          disabled={publishCount === 0}
          aria-label={`Publish site design, ${publishCount} ${publishCount === 1 ? "change" : "changes"}`}
        >
          Publish site design{" "}
          <span className="gl-styles__count" aria-hidden="true">
            {publishCount}
          </span>
        </Button>
      </header>

      <div className="gl-styles__body">
        <div className="gl-styles__form">
          <nav className="gl-segmented gl-styles__groups" aria-label="Style groups">
            {STYLE_GROUPS.filter((group) => groupHasFields(form, group.id)).map((group) => (
              <button key={group.id} type="button" onClick={() => jumpTo(group.id)}>
                {group.title}
              </button>
            ))}
          </nav>

          {draft.conflict && (
            <Notice
              tone="warning"
              live="alert"
              title="Another admin changed the styles a moment ago"
              onDismiss={draft.dismissConflict}
            >
              {draft.conflict.change
                ? `Your last change, ${draft.conflict.change}, wasn't saved${draft.conflict.later ? ", nor what you changed after it" : ""}. `
                : "Nothing of yours was published. "}
              The form now shows their version. Make the change again if you still want it.
            </Notice>
          )}
          {draft.stale.length > 0 && (
            <Notice tone="info" title={`Some saved values aren't in ${themeName} any more`}>
              {draft.stale.join(", ")}: kept, but not used. Your next change removes them.
            </Notice>
          )}

          {groupHasFields(form, "colors") && (
            <StyleSection id="colors" overrides={overrides} onReset={reset}>
              <ColorTable rows={form.colors} fieldProps={fieldProps} flagged={contrast.flagged} caption="Colours" />
              <ContrastPanel summary={contrast} />
            </StyleSection>
          )}

          {groupHasFields(form, "blockColors") && (
            <section
              className="gl-styles__section gl-styles__disclosure"
              aria-labelledby={`${SECTION_ID.blockColors}-h`}
            >
              <div className="gl-styles__section-head">
                <div className="gl-styles__disclosure-text">
                  <h2 id={`${SECTION_ID.blockColors}-h`} className="gl-styles__group-title" tabIndex={-1}>
                    <button
                      type="button"
                      className="gl-styles__disclosure-toggle"
                      aria-expanded={blockColorsOpen}
                      aria-controls={`${SECTION_ID.blockColors}-body`}
                      aria-describedby={`${SECTION_ID.blockColors}-help`}
                      onClick={() => setBlockColorsOpen((open) => !open)}
                    >
                      <ChevronRightIcon size={16} />
                      Block colours
                    </button>
                  </h2>
                  <span id={`${SECTION_ID.blockColors}-help`} className="gl-styles__help">
                    The palette people pick from in a block's Colour menu: {form.blockColors.length} colours, text and
                    fill, light and dark.
                  </span>
                </div>
                <GroupActions id="blockColors" overrides={overrides} onReset={reset} />
              </div>
              <div id={`${SECTION_ID.blockColors}-body`} hidden={!blockColorsOpen}>
                <ColorTable
                  rows={form.blockColors.flatMap((token) => token.rows)}
                  fieldProps={fieldProps}
                  flagged={contrast.flagged}
                  caption="Block colours"
                />
              </div>
            </section>
          )}

          {groupHasFields(form, "fonts") && (
            <StyleSection id="fonts" overrides={overrides} onReset={reset}>
              <div className="gl-styles__grid gl-styles__grid--3">
                {form.fonts.map((field) => (
                  <Select
                    key={field.path}
                    label={field.label}
                    value={fieldText(field, overrides)}
                    onChange={(value) => pick(field, value)}
                    options={fontChoices(form, field, themeName, server.system_fonts)}
                    error={errors[field.path]}
                  />
                ))}
              </div>
              <p className="gl-styles__help">{themeName} ships its own fonts. System fonts need no download.</p>
            </StyleSection>
          )}

          {groupHasFields(form, "typeScale") && (
            <StyleSection id="typeScale" overrides={overrides} onReset={reset}>
              {form.fontSizes.length > 0 && (
                <ul className="gl-styles__scale" aria-label="Font sizes">
                  {form.fontSizes.map((field) => (
                    <li key={field.path} className="gl-styles__scale-row">
                      <span className="gl-styles__mono gl-styles__scale-key" aria-hidden="true">
                        {field.path.split(".").pop()}
                      </span>
                      <TokenField {...fieldProps(field)} hideLabel className="gl-styles__scale-field" />
                      <span
                        className="gl-styles__scale-sample"
                        aria-hidden="true"
                        style={{
                          fontSize: errors[field.path] ? field.defaultText : fieldText(field, overrides),
                          fontFamily: fontStack(
                            form,
                            fieldText(form.fields.get("typography.fontFamily.heading") ?? field, overrides)
                          ),
                        }}
                      >
                        Aa
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {form.lineHeights.length > 0 && (
                <div className="gl-styles__grid gl-styles__grid--4">
                  {form.lineHeights.map((field) => (
                    <TokenField key={field.path} {...fieldProps(field)} hint="1 to 2.5" />
                  ))}
                </div>
              )}
            </StyleSection>
          )}

          {groupHasFields(form, "layout") && (
            <StyleSection id="layout" overrides={overrides} onReset={reset}>
              <div className="gl-styles__grid gl-styles__grid--3">
                {form.layout.map((field) => (
                  <TokenField key={field.path} {...fieldProps(field)} />
                ))}
              </div>
              <p className="gl-styles__help">
                Content width can't be wider than the wide width, and the wide width can't be wider than the container.
              </p>
            </StyleSection>
          )}

          {groupHasFields(form, "spacingRadius") && (
            <StyleSection id="spacingRadius" overrides={overrides} onReset={reset}>
              {form.spacing.length > 0 && (
                <div className="gl-styles__grid gl-styles__grid--5">
                  {form.spacing.map((field) => (
                    <TokenField key={field.path} {...fieldProps(field)} mono />
                  ))}
                </div>
              )}
              {form.radius.length > 0 && (
                <div className="gl-styles__grid gl-styles__grid--4">
                  {form.radius.map((field) => (
                    <TokenField key={field.path} {...fieldProps(field)} mono />
                  ))}
                </div>
              )}
              <p className="gl-styles__help">Each space step can't be smaller than the one before it.</p>
            </StyleSection>
          )}
        </div>

        <StylesPreview reloadKey={previewKey} />
      </div>

      <Modal
        isOpen={resetAllOpen}
        onClose={() => setResetAllOpen(false)}
        title="Reset all global styles?"
        size="small"
        footer={
          <div className="gl-styles-dialog__footer">
            <Button variant="secondary" onClick={() => setResetAllOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={resetAll}>
              Reset all
            </Button>
          </div>
        }
      >
        <p>Every colour, font, size and spacing goes back to {themeName}'s. Readers see it when you publish.</p>
      </Modal>

      <PublishDesignDialog
        isOpen={publishOpen}
        onClose={() => setPublishOpen(false)}
        styles={server}
        unsavedNote={unsavedNote}
        onPublished={(styles) => draft.adopt(styles, false)}
        onStylesChanged={draft.showConflict}
      />
    </div>
  )
}

function groupHasFields(form: StyleForm, id: StyleGroupId): boolean {
  if (id === "colors") return form.colors.length > 0
  if (id === "blockColors") return form.blockColors.length > 0
  if (id === "fonts") return form.fonts.length > 0
  if (id === "typeScale") return form.fontSizes.length + form.lineHeights.length > 0
  if (id === "layout") return form.layout.length > 0
  return form.spacing.length + form.radius.length > 0
}

// ---- Pieces ----

function GroupActions({
  id,
  overrides,
  onReset,
}: {
  id: StyleGroupId
  overrides: Overrides
  onReset: (id: StyleGroupId) => void
}) {
  const changed = groupChanged(overrides, id)
  const title = styleGroup(id).title
  return (
    <>
      {changed && <Pill tone="accent">Changed</Pill>}
      <span className="gl-styles__spacer" />
      <Button variant="ghost" onClick={() => onReset(id)} disabled={!changed}>
        Reset {title.toLowerCase()}
      </Button>
    </>
  )
}

function StyleSection({
  id,
  overrides,
  onReset,
  children,
}: {
  id: StyleGroupId
  overrides: Overrides
  onReset: (id: StyleGroupId) => void
  children: ReactNode
}) {
  const headingId = `${SECTION_ID[id]}-h`
  return (
    <section className="gl-styles__section" id={SECTION_ID[id]} aria-labelledby={headingId}>
      <div className="gl-styles__section-head">
        <h2 id={headingId} className="gl-styles__group-title" tabIndex={-1}>
          {styleGroup(id).title}
        </h2>
        <GroupActions id={id} overrides={overrides} onReset={onReset} />
      </div>
      {children}
    </section>
  )
}

type FieldProps = {
  field: StyleField
  text: string
  error?: string
  changed: boolean
  onChange: (text: string) => void
  onCommit: () => void
}

/** A length or line height: plain text, sent as typed (the shared validator decides). */
function TokenField({
  field,
  text,
  error,
  changed,
  onChange,
  onCommit,
  hint,
  hideLabel,
  mono,
  className = "",
}: FieldProps & { hint?: string; hideLabel?: boolean; mono?: boolean; className?: string }) {
  const id = useId()
  return (
    <div className={`gl-styles-field ${error ? "is-invalid" : ""} ${className}`}>
      <label
        htmlFor={id}
        className={hideLabel ? "gl-visually-hidden" : `gl-styles-field__label${mono ? "gl-styles__mono" : ""}`}
      >
        {field.label}
        {changed && <span className="gl-visually-hidden"> (changed)</span>}
      </label>
      <input
        id={id}
        className="gl-styles-field__input gl-styles__mono"
        type="text"
        inputMode={field.kind === "lineHeight" ? "decimal" : undefined}
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onCommit}
      />
      <FieldMessage id={id} hint={hint} error={error} />
    </div>
  )
}

/** A colour: the hex text and the browser's picker, with the field's contrast flag. */
function ColorField({ field, text, error, changed, onChange, onCommit, flagged }: FieldProps & { flagged: boolean }) {
  const id = useId()
  const swatch = normalizeColor(text) ?? normalizeColor(field.defaultText) ?? "#000000"
  const hint = !error && flagged ? "Fails contrast" : undefined
  return (
    <div className={`gl-styles-color ${error ? "is-invalid" : ""} ${flagged ? "is-flagged" : ""}`}>
      <div className="gl-styles-color__control">
        <input
          type="color"
          className="gl-styles-color__swatch"
          value={swatch}
          aria-label={`${field.label}, colour picker`}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={onCommit}
        />
        <label htmlFor={id} className="gl-visually-hidden">
          {field.label}
        </label>
        <input
          id={id}
          type="text"
          className="gl-styles-color__text gl-styles__mono"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={onCommit}
        />
        {changed && <span className="gl-styles__tag">Changed</span>}
      </div>
      <FieldMessage id={id} hint={hint} error={error} />
    </div>
  )
}

function ColorTable({
  rows,
  fieldProps,
  flagged,
  caption,
}: {
  rows: ColorRow[]
  fieldProps: (field: StyleField) => FieldProps
  flagged: ReadonlySet<string>
  caption: string
}) {
  const cell = (row: ColorRow, palette: "light" | "dark") => {
    const field = row[palette]
    if (!field) return <td className="gl-styles__none">Not in this palette</td>
    const name = field.path.replace(/^(colors|blockColors)\.(light|dark)\./, "")
    const tokenName = field.path.startsWith("blockColors.") ? `blockColors.${name}` : name
    return (
      <td>
        <ColorField {...fieldProps(field)} flagged={flagged.has(`${palette}:${tokenName}`)} />
      </td>
    )
  }
  return (
    <table className="gl-styles__table">
      <caption className="gl-visually-hidden">{caption}, light and dark</caption>
      <thead>
        <tr>
          <th scope="col">Token</th>
          <th scope="col">Light</th>
          <th scope="col">Dark</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <th scope="row">
              <span className="gl-styles__token-name">{row.label}</span>
              {row.use && <span className="gl-styles__help">{row.use}</span>}
            </th>
            {cell(row, "light")}
            {cell(row, "dark")}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PairFlag({ result }: { result?: PairResult }) {
  if (!result) return <span className="gl-styles__none">—</span>
  return result.pass ? (
    <span className="gl-styles-flag is-pass">
      <CheckIcon size={14} />
      {formatRatio(result.ratio)}
    </span>
  ) : (
    <span className="gl-styles-flag is-fail">
      <WarningIcon size={14} />
      {formatRatio(result.ratio)} · {formatMinimum(result.minimum)}
    </span>
  )
}

function CountFlag({ count }: { count: { total: number; passing: number } }) {
  const allPass = count.passing === count.total
  return (
    <span className={`gl-styles-flag ${allPass ? "is-pass" : "is-fail"}`}>
      {allPass ? <CheckIcon size={14} /> : <DangerIcon size={14} />}
      {passCount(count)}
    </span>
  )
}

function ContrastPanel({ summary }: { summary: ContrastSummary }) {
  return (
    <div className="gl-styles__contrast">
      <p className="gl-styles__contrast-head">
        <strong>Contrast</strong>
        <span className="gl-styles__help">
          Text pairs need 4.5:1, controls 3:1. Checked as you type; a failing pair can still be published, after a
          warning.
        </span>
      </p>
      <table className="gl-styles__table">
        <caption className="gl-visually-hidden">Contrast of colour pairs, light and dark</caption>
        <thead>
          <tr>
            <th scope="col">Pair</th>
            <th scope="col">Light</th>
            <th scope="col">Dark</th>
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>
                <PairFlag result={row.light} />
              </td>
              <td>
                <PairFlag result={row.dark} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">Other colour pairs</th>
            <td>
              <CountFlag count={summary.others.light} />
            </td>
            <td>
              <CountFlag count={summary.others.dark} />
            </td>
          </tr>
          {summary.blocks.light.total + summary.blocks.dark.total > 0 && (
            <tr>
              <th scope="row">Block colours, as text and fill</th>
              <td>
                <CountFlag count={summary.blocks.light} />
              </td>
              <td>
                <CountFlag count={summary.blocks.dark} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const STATUS_TEXT: Record<SaveState, string> = {
  saved: "Saved",
  pending: "Saving…",
  saving: "Saving…",
  invalid: "Fix the marked value to save",
  failed: "Couldn't save your last change",
}

/**
 * The save state. Only a failure, and the save after it, are spoken (#477: transitions,
 * not every keystroke); the field errors speak for themselves (role="alert").
 */
function SaveStatus({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  const [announcement, setAnnouncement] = useState("")
  const previous = useRef(state)
  useEffect(() => {
    if (state === "failed") setAnnouncement(`Couldn't save your last change. ${error ?? ""}`.trim())
    else if (state === "saved" && previous.current === "saving" && announcement) setAnnouncement("Saved")
    previous.current = state
  }, [state, error]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <span className={`gl-styles__status is-${state}`} title={state === "failed" ? (error ?? undefined) : undefined}>
        {state === "saved" && <CheckIcon size={14} />}
        {state === "failed" && <DangerIcon size={14} />}
        {STATUS_TEXT[state]}
      </span>
      {state === "failed" && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
      <span className="gl-visually-hidden" role="status">
        {announcement}
      </span>
    </>
  )
}

/**
 * Leaving with a change that isn't saved asks first (13.1): closing or reloading the tab
 * while anything is unsaved (beforeunload), and a link inside the admin while a change
 * can't be saved (refused, or its save failed). A change still waiting for its pause is
 * sent when the page unmounts, so a link doesn't ask about that one.
 */
function useLeaveWarning(state: SaveState) {
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (stateRef.current === "saved") return
      event.preventDefault()
      event.returnValue = ""
    }
    const onClick = (event: MouseEvent) => {
      const stuck = stateRef.current === "invalid" || stateRef.current === "failed"
      if (
        !stuck ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!link || link.target === "_blank" || link.origin !== window.location.origin || link.closest(".gl-styles"))
        return
      if (!window.confirm("Your last change to the styles isn't saved. Leave anyway?")) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    document.addEventListener("click", onClick, true)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      document.removeEventListener("click", onClick, true)
    }
  }, [])
}
