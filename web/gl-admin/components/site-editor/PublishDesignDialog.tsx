import { useEffect, useRef, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { toast } from "@gl-admin/components/ui/Toast"
import { changedGlobalStyleGroups, type ContrastFailure } from "@/lib/globalStyles"
import {
  ContrastUnconfirmedError,
  DesignInvalidError,
  StylesChangedError,
  getGlobalStyles,
  getSiteDesignOverview,
  publishSiteDesign,
  type GlobalStylesResponse,
  type SiteDesignOverview,
  type SiteDesignProblem,
  type SiteDesignPublishResponse,
} from "@gl-admin/lib/api/siteDesign"
import { errorMessage } from "@gl-admin/lib/api/errors"
import "@gl-admin/assets/styles/pages/global-styles.scss"
import { changedGroupsLabel, failureLabel, formatMinimum, formatRatio } from "@gl-admin/lib/globalStyles"
import { groupsLabel, problemText, publishChanges, type PublishChange, type SiteVocabulary } from "@gl-admin/lib/siteDesign"
import { plural } from "@gl-admin/utils/formatting"

// "Publish site design" (#487, #492, #493; the board "Publish site design, reset & discard"),
// for the global styles screen, the Site editor's overview and its template and part editors.
// One publish puts every changed template, part and the styles of the active theme live
// together (design 8.2): the dialog lists them, read from the overview when it opens.
// Refusals come first and alone (an empty template, a part that resolves to nothing), each
// with Open; contrast asks, never refuses (6.3): the failing pairs and "Publish anyway". A
// failed flush says nothing was published.

type Props = {
  isOpen: boolean
  onClose: () => void
  /** The styles as the styles screen has them (its contrast pairs); read when the dialog opens otherwise. */
  styles?: GlobalStylesResponse | null
  /** A note above the list when the form's latest change didn't save first. */
  unsavedNote?: string | null
  /** Called with the published styles (the styles screen adopts them). */
  onPublished?: (styles: GlobalStylesResponse, result: SiteDesignPublishResponse) => void
  onStylesChanged?: (current: GlobalStylesResponse) => void
  /** Opens a template or part named in a refusal (its editor). Absent on a phone: fix it on a larger screen. */
  onOpenItem?: (id: number) => void
  /** Opens the global styles, from the contrast warning. */
  onOpenStyles?: () => void
  /** Run before publishing: the template editor waits for the server to have every edit typed here. */
  beforePublish?: () => Promise<void>
  vocabulary?: SiteVocabulary
}

export default function PublishDesignDialog({
  isOpen,
  onClose,
  styles = null,
  unsavedNote,
  onPublished,
  onStylesChanged,
  onOpenItem,
  onOpenStyles,
  beforePublish,
  vocabulary,
}: Props) {
  const [overview, setOverview] = useState<SiteDesignOverview | null>(null)
  // The overview couldn't be read: the list may be short, never "nothing to publish".
  const [readFailed, setReadFailed] = useState(false)
  const [stylesNow, setStylesNow] = useState<GlobalStylesResponse | null>(styles)
  const [loading, setLoading] = useState(false)
  const [pairs, setPairs] = useState<ContrastFailure[]>(styles?.contrast ?? [])
  const [problems, setProblems] = useState<SiteDesignProblem[]>([])
  const [publishing, setPublishing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // Read what would go live each time it opens: someone else may have changed anything. Only
  // when it opens: the screen adopts the published styles before the dialog closes, and a
  // re-read then would replace the dialog with "Nothing to publish".
  const stylesRef = useRef(styles)
  stylesRef.current = styles
  useEffect(() => {
    if (!isOpen) return
    let live = true
    setFailure(null)
    setProblems([])
    setLoading(true)
    setStylesNow(stylesRef.current)
    setPairs(stylesRef.current?.contrast ?? [])
    void (async () => {
      const read = await getSiteDesignOverview().catch(() => null)
      let current = stylesRef.current
      if (!current && read?.global_styles_changed) current = await getGlobalStyles().catch(() => null)
      if (!live) return
      setOverview(read)
      setReadFailed(read === null)
      if (current) {
        setStylesNow(current)
        setPairs(current.contrast ?? [])
      }
      setLoading(false)
    })()
    return () => {
      live = false
    }
  }, [isOpen])

  // What the list shows: the overview's templates and parts (none if it couldn't be read),
  // then the styles, from the styles themselves when they're at hand (the styles screen's are
  // newer than the overview's read).
  const templates = Array.isArray(overview?.templates) ? overview!.templates : []
  const stylesChanged = stylesNow ? stylesNow.has_unpublished_changes : !!overview?.global_styles_changed
  const changes: PublishChange[] = [
    ...publishChanges({ templates, global_styles_changed: false, global_styles_groups: [] }, vocabulary),
    ...(stylesChanged
      ? [
          {
            key: "styles",
            id: null,
            kind: "styles" as const,
            name: "Global styles",
            what: stylesNow
              ? changedGroupsLabel(changedGlobalStyleGroups(stylesNow.published, stylesNow.draft)) || "Changed"
              : groupsLabel(overview?.global_styles_groups),
          },
        ]
      : []),
  ]
  const nothing = !loading && !readFailed && changes.length === 0 && problems.length === 0

  const publish = async () => {
    setPublishing(true)
    setFailure(null)
    try {
      await beforePublish?.()
      // Only after the pairs were shown: a pair the dialog didn't list asks again.
      const result = await publishSiteDesign({ confirmContrast: pairs.length > 0 })
      onPublished?.(result.styles, result)
      const count = (result.templates?.length ?? 0) + (result.global_styles ? 1 : 0)
      toast.success(`Site design published · ${plural(count, "change", "changes")}`, {
        action: { label: "View site", onClick: () => window.open("/", "_blank", "noopener") },
      })
      onClose()
    } catch (error) {
      if (error instanceof ContrastUnconfirmedError) setPairs(error.pairs)
      else if (error instanceof DesignInvalidError) setProblems(error.problems)
      else if (error instanceof StylesChangedError) {
        onStylesChanged?.(error.current)
        if (onStylesChanged) onClose()
        else setFailure("Nothing was published. Another admin changed the global styles a moment ago; open the dialog again to see them.")
      } else setFailure(`Nothing was published. ${errorMessage(error)}`)
    } finally {
      setPublishing(false)
    }
  }

  const refused = problems.length > 0
  const title = refused
    ? `Fix ${plural(problems.length, "thing", "things")} before publishing`
    : loading
      ? "Publish site design?"
      : nothing
        ? "Nothing to publish"
        : "Publish site design?"

  return (
    <Modal
      isOpen={isOpen}
      onClose={publishing ? () => {} : onClose}
      title={title}
      size="medium"
      footer={
        <div className="gl-styles-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={publishing}>
            {nothing || refused ? "Close" : "Cancel"}
          </Button>
          {!nothing && (
            <Button variant="primary" onClick={publish} loading={publishing} disabled={loading || refused}>
              {failure ? "Try again" : pairs.length > 0 ? "Publish anyway" : "Publish"}
            </Button>
          )}
        </div>
      }
    >
      <div className="gl-styles-dialog" aria-busy={loading || undefined}>
        {refused ? (
          <>
            <p>Nothing was published. These would break pages for readers.</p>
            <ul className="gl-styles-dialog__problems">
              {problems.map((problem) => {
                const text = problemText(problem, templates, vocabulary)
                return (
                  <li key={text.key}>
                    <Notice
                      tone="danger"
                      title={text.title}
                      actions={
                        onOpenItem && text.openId != null ? (
                          <Button variant="secondary" size="sm" onClick={() => onOpenItem(text.openId!)}>
                            {text.openLabel}
                          </Button>
                        ) : undefined
                      }
                    >
                      {text.body}
                      {!onOpenItem && " Fix it on a larger screen."}
                    </Notice>
                  </li>
                )
              })}
            </ul>
            <p className="gl-styles-dialog__hint">Contrast warnings, if any, come after these are fixed.</p>
          </>
        ) : nothing ? (
          <p>The site already shows the latest design.</p>
        ) : (
          <>
            <p>These go live on {window.location.host} together. Each keeps a version in History.</p>
            {readFailed && (
              <Notice tone="warning" title="Couldn’t read every change">
                The list below may be incomplete. Publishing still puts every change of the active theme live.
              </Notice>
            )}
            {unsavedNote && (
              <Notice tone="warning" title="Your latest change isn't saved">
                {unsavedNote} This publishes the styles as they were last saved.
              </Notice>
            )}
            <ul className="gl-styles-dialog__changes" aria-label="What goes live">
              {loading && changes.length === 0 ? (
                <li className="gl-styles-dialog__loading">Reading what changed…</li>
              ) : (
                changes.map((change) => (
                  <li key={change.key}>
                    <span className="gl-styles-dialog__change-name">{change.name}</span>
                    <span className="gl-styles-dialog__change-what">{change.what}</span>
                  </li>
                ))
              )}
            </ul>
            {changes.length > 1 && <p className="gl-styles-dialog__hint">To leave one out, discard its changes first.</p>}
            {pairs.length > 0 && (
              <Notice
                tone="warning"
                title={`${plural(pairs.length, "colour pair is", "colour pairs are")} hard to read`}
                actions={
                  onOpenStyles ? (
                    <Button variant="secondary" size="sm" onClick={onOpenStyles}>
                      Fix in global styles
                    </Button>
                  ) : undefined
                }
              >
                <table className="gl-styles-dialog__pairs">
                  <caption className="gl-visually-hidden">Colour pairs that fail contrast</caption>
                  <tbody>
                    {pairs.map((pair) => (
                      <tr key={`${pair.palette}:${pair.foreground}/${pair.background}`}>
                        <th scope="row">{failureLabel(pair)}</th>
                        <td>
                          {formatRatio(pair.ratio)} · {formatMinimum(pair.minimum)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p>Text in these colours may be hard to read. You can publish anyway; the release notes the warning.</p>
              </Notice>
            )}
            {failure && (
              <Notice tone="danger" live="alert">
                {failure}
              </Notice>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
