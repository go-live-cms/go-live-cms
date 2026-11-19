import { useEffect, useRef, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Textarea from "@gl-admin/components/ui/Textarea"
import { CheckIcon, CloseIcon } from "@gl-admin/components/ui/icons"
import { importMediaFromURLs } from "@gl-admin/lib/api/media"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { rememberMedia } from "@gl-admin/lib/mediaLookup"
import {
  MAX_IMPORT_LINKS,
  addButtonLabel,
  failedLinks,
  importRequestError,
  importSummary,
  parseImportLinks,
  resultLine,
  shortLink,
  type ImportResult,
} from "@gl-admin/lib/mediaImport"
import type { Media } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/components/media/add-from-url.scss"

// "Add from URL" (#29; the canvas's "Media · Add from URL" board): links, one per line,
// that the API downloads into the library like uploads (copy only: never hotlinked).
// The media library shows it as a dialog (AddFromURLDialog, next to Upload); the media
// picker, already a dialog, shows the same form in place (AddFromURLForm). States:
// empty, a line that isn't a link (the button stays off), adding (a row per link), and
// the results (added, or the API's reason), with "Try failed again".

type Phase = "editing" | "adding" | "done"

function useAddFromURL(onAdded: (media: Media[]) => void) {
  const [text, setText] = useState("")
  const [phase, setPhase] = useState<Phase>("editing")
  const [pending, setPending] = useState<string[]>([])
  const [results, setResults] = useState<ImportResult[]>([])
  const [requestError, setRequestError] = useState<string | null>(null)
  // Bumped by reset and on unmount: an answer that arrives after the dialog or the picker
  // closed picks nothing and changes nothing on screen (the files are in the library).
  const session = useRef(0)
  useEffect(
    () => () => {
      session.current++
    },
    []
  )
  const parsed = parseImportLinks(text)

  const submit = async () => {
    if (phase === "adding" || parsed.problem || parsed.links.length === 0) return
    const started = session.current
    setPhase("adding")
    setPending(parsed.links)
    setRequestError(null)
    try {
      const response = await importMediaFromURLs(parsed.links)
      const added = response.results.flatMap((r) => (r.status === "added" ? [r.media] : []))
      added.forEach(rememberMedia)
      // Closed meanwhile: the files are in the library, but nothing is picked.
      if (started !== session.current) return
      if (added.length > 0) onAdded(added)
      setResults(response.results)
      setPhase("done")
    } catch (e) {
      if (started !== session.current) return
      setRequestError(importRequestError(e instanceof ApiError ? e.status : undefined, errorMessage(e, "The links couldn't be added")))
      setPhase("editing")
    }
  }

  const retryFailed = () => {
    setText(failedLinks(results).join("\n"))
    setResults([])
    setPhase("editing")
  }

  const reset = () => {
    session.current++
    setText("")
    setPhase("editing")
    setPending([])
    setResults([])
    setRequestError(null)
  }

  return { text, setText, phase, pending, results, requestError, parsed, submit, retryFailed, reset }
}

type AddFromURLState = ReturnType<typeof useAddFromURL>

function Fields({ state }: { state: AddFromURLState }) {
  const { text, setText, phase, pending, results, requestError, parsed } = state
  const failures = results.filter((r) => r.status === "failed").length
  return (
    <div className="gl-add-from-url">
      {requestError && (
        <Notice tone="danger" live="alert">
          {requestError}
        </Notice>
      )}
      {phase === "done" ? (
        <>
          <p className={`gl-add-from-url__summary${failures > 0 ? " has-failures" : ""}`} role="status">
            {importSummary(results)}
          </p>
          <ul className="gl-add-from-url__rows" aria-label="Results">
            {results.map((result, i) => (
              <li key={`${i}-${result.url}`} className={`gl-add-from-url__row is-${result.status}`}>
                <span className="gl-add-from-url__icon" aria-hidden="true">
                  {result.status === "added" ? <CheckIcon size={16} /> : <CloseIcon size={16} />}
                </span>
                <span className="gl-add-from-url__link" title={result.url}>
                  {shortLink(result.url)}
                </span>
                <span className="gl-add-from-url__outcome">
                  <span className="gl-add-from-url__sr">{result.status === "added" ? "Added: " : "Failed: "}</span>
                  {resultLine(result)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <Textarea
            label="File links"
            rows={6}
            value={text}
            readOnly={phase === "adding"}
            placeholder="https://example.com/photo.jpg"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => state.setText(e.currentTarget.value)}
            error={parsed.problem ?? undefined}
            hint={`Up to ${MAX_IMPORT_LINKS} links. Images, video, audio and documents (PDF, DOC, TXT), up to 50 MB each.`}
          />
          {phase === "adding" && (
            <ul className="gl-add-from-url__rows" aria-label="Downloading" aria-busy="true">
              {pending.map((link) => (
                <li key={link} className="gl-add-from-url__row is-pending">
                  <span className="gl-add-from-url__spinner" aria-hidden="true" />
                  <span className="gl-add-from-url__link" title={link}>
                    {shortLink(link)}
                  </span>
                  <span className="gl-add-from-url__outcome">Downloading…</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function Actions({ state, onClose, closeLabel = "Cancel" }: { state: AddFromURLState; onClose: () => void; closeLabel?: string }) {
  const { phase, results, parsed } = state
  if (phase === "done") {
    const failures = results.some((r) => r.status === "failed")
    return failures ? (
      <>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={state.retryFailed}>
          Try failed again
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    )
  }
  const count = parsed.links.length
  return (
    <>
      <Button variant="ghost" onClick={onClose} disabled={phase === "adding"}>
        {closeLabel}
      </Button>
      <Button
        variant="primary"
        onClick={() => void state.submit()}
        loading={phase === "adding"}
        disabled={phase !== "adding" && (count === 0 || parsed.problem !== null)}
      >
        {phase === "adding" ? "Adding…" : addButtonLabel(count)}
      </Button>
    </>
  )
}

interface AddFromURLProps {
  /** The files just added to the library (called once per request that added any). */
  onAdded: (media: Media[]) => void
}

/** The media library's dialog, opened by "Add from URL" beside Upload. */
export function AddFromURLDialog({ isOpen, onClose, onAdded }: AddFromURLProps & { isOpen: boolean; onClose: () => void }) {
  const state = useAddFromURL(onAdded)
  const { reset } = state
  useEffect(() => {
    if (!isOpen) reset()
  }, [isOpen])
  const close = () => {
    if (state.phase !== "adding") onClose()
  }
  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Add from URL"
      description="Paste links to files, one per line. GoLive downloads each one into the library, like an upload."
      closeOnBackdrop={false}
      footer={
        <div className="gl-add-from-url__actions">
          <Actions state={state} onClose={close} />
        </div>
      }
    >
      <Fields state={state} />
    </Modal>
  )
}

/** The media picker's form, shown in place of its grid's top while open. */
export function AddFromURLForm({ onAdded, onClose }: AddFromURLProps & { onClose: () => void }) {
  const state = useAddFromURL(onAdded)
  return (
    <section className="gl-add-from-url__panel" aria-label="Add from URL">
      <p className="gl-add-from-url__intro">Paste links to files, one per line. GoLive downloads each one into the library, like an upload.</p>
      <Fields state={state} />
      <div className="gl-add-from-url__actions">
        <Actions state={state} onClose={onClose} />
      </div>
    </section>
  )
}
