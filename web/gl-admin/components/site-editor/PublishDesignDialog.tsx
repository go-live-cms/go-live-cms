import { useEffect, useState } from "react"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import { toast } from "@gl-admin/components/ui/Toast"
import { changedGlobalStyleGroups, type ContrastFailure } from "@/lib/globalStyles"
import {
  ContrastUnconfirmedError,
  StylesChangedError,
  publishSiteDesign,
  type GlobalStylesResponse,
} from "@gl-admin/lib/api/siteDesign"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { changedGroupsLabel, failureLabel, formatMinimum, formatRatio } from "@gl-admin/lib/globalStyles"
import { plural } from "@gl-admin/utils/formatting"

// "Publish site design" for the global styles screen (#487; the board "Publish site design,
// reset & discard"). For now a publish is the styles only (the API's styles-only publish,
// #485); #492 lists templates and parts here too, through the same publishSiteDesign.
// Contrast asks, never refuses (design 6.3): the failing pairs are shown and the button is
// "Publish anyway".

type Props = {
  isOpen: boolean
  onClose: () => void
  styles: GlobalStylesResponse
  /** A note above the list when the form's latest change didn't save first. */
  unsavedNote?: string | null
  onPublished: (styles: GlobalStylesResponse) => void
  onStylesChanged: (current: GlobalStylesResponse) => void
}

export default function PublishDesignDialog({
  isOpen,
  onClose,
  styles,
  unsavedNote,
  onPublished,
  onStylesChanged,
}: Props) {
  const [pairs, setPairs] = useState<ContrastFailure[]>(styles.contrast)
  const [publishing, setPublishing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setPairs(styles.contrast)
    setFailure(null)
  }, [isOpen, styles])

  const groups = changedGlobalStyleGroups(styles.published, styles.draft)
  const nothing = !styles.has_unpublished_changes

  const publish = async () => {
    setPublishing(true)
    setFailure(null)
    try {
      // Only after the pairs were shown: a pair the dialog didn't list asks again.
      const result = await publishSiteDesign({ confirmContrast: pairs.length > 0 })
      onPublished(result.styles)
      toast.success("Site design published", {
        action: { label: "View site", onClick: () => window.open("/", "_blank", "noopener") },
      })
      onClose()
    } catch (error) {
      if (error instanceof ContrastUnconfirmedError) setPairs(error.pairs)
      else if (error instanceof StylesChangedError) {
        onStylesChanged(error.current)
        onClose()
      } else setFailure(`Nothing was published. ${errorMessage(error)}`)
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={publishing ? () => {} : onClose}
      title={nothing ? "Nothing to publish" : "Publish site design?"}
      size="medium"
      footer={
        <div className="gl-styles-dialog__footer">
          <Button variant="secondary" onClick={onClose} disabled={publishing}>
            {nothing ? "Close" : "Cancel"}
          </Button>
          {!nothing && (
            <Button variant="primary" onClick={publish} loading={publishing}>
              {failure ? "Try again" : pairs.length > 0 ? "Publish anyway" : "Publish"}
            </Button>
          )}
        </div>
      }
    >
      <div className="gl-styles-dialog">
        {nothing ? (
          <p>The site already uses these styles.</p>
        ) : (
          <>
            <p>These go live on {window.location.host} for every reader. The release keeps a version.</p>
            {unsavedNote && (
              <Notice tone="warning" title="Your latest change isn't saved">
                {unsavedNote} This publishes the styles as they were last saved.
              </Notice>
            )}
            <ul className="gl-styles-dialog__changes">
              <li>
                <span className="gl-styles-dialog__change-name">Global styles</span>
                <span className="gl-styles-dialog__change-what">
                  {groups.length > 0 ? changedGroupsLabel(groups) : "Changed"}
                </span>
              </li>
            </ul>
            {pairs.length > 0 && (
              <Notice
                tone="warning"
                title={`${plural(pairs.length, "colour pair is", "colour pairs are")} hard to read`}
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
