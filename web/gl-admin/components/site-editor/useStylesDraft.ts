import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { StylesChangedError, saveGlobalStyles, type GlobalStylesResponse } from "@gl-admin/lib/api/siteDesign"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  buildStyleForm,
  describeChange,
  draftFromOverrides,
  fieldErrors,
  overridesFromDraft,
  type LastChange,
  type Overrides,
  type StyleForm,
} from "@gl-admin/lib/globalStyles"
import type { GlobalStylesTheme } from "@/lib/globalStyles"

// The styles form's saving (design 6.5, 13.1): no Save button. Each change saves the whole
// draft with the revision it was made to, debounced; a field that blurs saves at once, and
// so does a Reset. A value the validator refuses stays in its field, named, and nothing is
// sent. A failed save keeps every typed value and offers Try again. When another admin
// saved first (409 styles_changed), nothing is merged: the form shows their draft and says
// which change wasn't saved.

export const SAVE_DELAY_MS = 600

export type SaveState = "saved" | "pending" | "saving" | "invalid" | "failed"

export interface StylesConflict {
  /** "Primary (light) to #155e4b": the change the refused save carried. */
  change: string | null
  /** Something was typed while it was being saved: replaced as well. */
  later?: boolean
}

export function useStylesDraft(initial: GlobalStylesResponse, { onSaved }: { onSaved: () => void }) {
  const [server, setServer] = useState(initial)
  const [form, setForm] = useState<StyleForm>(() => buildStyleForm(initial.tokens, initial.font_options))
  const start = useMemo(() => overridesFromDraft(form, initial.draft), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [overrides, setOverrides] = useState<Overrides>(start.overrides)
  const [stale, setStale] = useState<string[]>(start.stale)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<StylesConflict | null>(null)

  const formRef = useRef(form)
  formRef.current = form
  const overridesRef = useRef(overrides)
  const staleRef = useRef(stale)
  staleRef.current = stale
  const revisionRef = useRef(initial.draft_revision)
  const savedKeyRef = useRef(JSON.stringify(draftFromOverrides(form, start.overrides)))
  const lastChangeRef = useRef<LastChange | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef<Promise<boolean> | null>(null)
  const tokensKeyRef = useRef(JSON.stringify([initial.tokens, initial.font_options]))
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const theme: GlobalStylesTheme = useMemo(
    () => ({ tokens: server.tokens, fontOptions: server.font_options }),
    [server.tokens, server.font_options]
  )
  const themeRef = useRef(theme)
  themeRef.current = theme

  // A response becomes the form's server copy; `replace` also takes its draft into the fields.
  const adopt = useCallback((response: GlobalStylesResponse, replace: boolean) => {
    setServer(response)
    revisionRef.current = response.draft_revision
    let current = formRef.current
    // Another admin may have switched themes meanwhile: then the fields are that theme's.
    const tokensKey = JSON.stringify([response.tokens, response.font_options])
    if (tokensKey !== tokensKeyRef.current) {
      tokensKeyRef.current = tokensKey
      current = buildStyleForm(response.tokens, response.font_options)
      formRef.current = current
      setForm(current)
    }
    const stored = overridesFromDraft(current, response.draft)
    setStale(stored.stale)
    staleRef.current = stored.stale
    if (replace) {
      overridesRef.current = stored.overrides
      setOverrides(stored.overrides)
      setErrors({})
    }
    savedKeyRef.current = JSON.stringify(draftFromOverrides(current, stored.overrides))
  }, [])

  const flush = useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<boolean> => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      // One save at a time: this one runs after the save in flight, with whatever is newest then.
      if (inFlightRef.current) return inFlightRef.current.then(() => flush({ force }))
      const current = overridesRef.current
      const problems = fieldErrors(formRef.current, current, themeRef.current)
      setErrors(problems)
      if (Object.keys(problems).length > 0) {
        setSaveState("invalid")
        return false
      }
      const draft = draftFromOverrides(formRef.current, current)
      const key = JSON.stringify(draft)
      if (key === savedKeyRef.current && !(force && staleRef.current.length > 0)) {
        setSaveState("saved")
        return true
      }
      setSaveState("saving")
      setSaveError(null)
      // The change this save carries: a 409 names it, not one typed while it was in flight.
      const sent = lastChangeRef.current
      const run = (async () => {
        try {
          const response = await saveGlobalStyles(draft, revisionRef.current)
          adopt(response, false)
          savedKeyRef.current = key
          onSavedRef.current()
          return true
        } catch (error) {
          if (error instanceof StylesChangedError) {
            // Edits typed meanwhile are replaced by their draft too, so the notice says so.
            const later = lastChangeRef.current !== sent
            const form = formRef.current
            adopt(error.current, true)
            setConflict({ change: sent ? describeChange(form, sent) : null, later })
            onSavedRef.current()
            return true
          }
          setSaveError(errorMessage(error))
          return false
        }
      })()
      inFlightRef.current = run
      const ok = await run
      inFlightRef.current = null
      if (!ok) {
        setSaveState("failed")
        return false
      }
      // A change arrived while this one was saving (or a 409 replaced the fields): check again.
      if (overridesRef.current !== current) return flush()
      setSaveState("saved")
      return true
    },
    [adopt]
  )

  /** A field's new text (or a Reset): kept at once, saved after a pause. */
  const change = useCallback(
    (next: Overrides, what: LastChange, { now = false }: { now?: boolean } = {}) => {
      overridesRef.current = next
      lastChangeRef.current = what
      setOverrides(next)
      setSaveState("pending")
      if (timerRef.current) clearTimeout(timerRef.current)
      if (now) void flush()
      else timerRef.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
    },
    [flush]
  )

  /** Saves what's pending now (a field lost focus). */
  const commit = useCallback(() => {
    if (timerRef.current) void flush()
  }, [flush])

  // Leaving with a change still waiting for its pause sends it (the request outlives the page).
  useEffect(
    () => () => {
      if (timerRef.current) void flush()
    },
    [flush]
  )

  const unsaved = saveState !== "saved"

  return {
    server,
    form,
    theme,
    overrides,
    stale,
    errors,
    saveState,
    saveError,
    conflict,
    unsaved,
    change,
    commit,
    flush,
    adopt,
    dismissConflict: () => setConflict(null),
    showConflict: (current: GlobalStylesResponse) => {
      adopt(current, true)
      setConflict({ change: null })
      onSavedRef.current()
    },
  }
}
