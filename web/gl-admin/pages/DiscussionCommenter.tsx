import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  announceDiscussionChanged,
  eraseCommenter,
  exportCommenter,
  getCommenter,
  setCommenterBlocked,
  type CommenterSummary,
  type ModerationComment,
} from "@gl-admin/lib/api/discussion"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { STATUS_LABELS, blockedLine, eraseConfirm, erasedMessage, exportFileName, mailLine, networkLine } from "@gl-admin/lib/discussion"
import { isSiteAdmin } from "@gl-admin/lib/roles"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { formatLastEdited } from "@gl-admin/lib/contentList"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import Avatar from "@gl-admin/components/ui/Avatar"
import Button, { buttonClassName } from "@gl-admin/components/ui/Button"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Modal from "@gl-admin/components/ui/Modal"
import Notice from "@gl-admin/components/ui/Notice"
import Pill, { type PillTone } from "@gl-admin/components/ui/Pill"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { toast } from "@gl-admin/components/ui/Toast"
import "@gl-admin/assets/styles/pages/discussion.scss"

// A commenter's page (#526; design 13.1, 16.1, the "Discussion · commenter" board): one
// email address on this site, opened from the drawer or Find a commenter. Editors and
// admins see the address in full (decision 6) and can Block; Export and Erase are an
// admin's (#529, the API's requireSiteAdmin): Export downloads the commenter's file, Erase
// asks first and then leaves this page for the queue. Every comment of theirs in every
// status, how many ask for reply mail, and how many other commenters posted from their
// network.

const TONES: Record<string, PillTone> = { pending: "warning", approved: "success", spam: "danger", trash: "neutral" }

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

export default function DiscussionCommenter() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<{ commenter: CommenterSummary; comments: ModerationComment[] } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [confirmErase, setConfirmErase] = useState(false)
  const [erasing, setErasing] = useState(false)
  const [reload, setReload] = useState(0)
  const admin = isSiteAdmin(useAuthUser()?.role)
  const navigate = useNavigate()
  usePageTitle(data ? data.commenter.name : "Commenter")

  useEffect(() => {
    let live = true
    setError(null)
    getCommenter(Number(id))
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e))
    return () => {
      live = false
    }
  }, [id, reload])

  const toggleBlock = async () => {
    if (!data) return
    const blocked = !data.commenter.blocked_at
    setBusy(true)
    try {
      const commenter = await setCommenterBlocked(data.commenter.id, blocked)
      setData({ ...data, commenter })
      toast.success(blocked ? "Blocked. New comments from this address go to Spam." : "Unblocked.")
      announceDiscussionChanged()
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't save the block"))
    } finally {
      setBusy(false)
    }
  }

  const runExport = async () => {
    if (!data) return
    setExporting(true)
    try {
      const file = await exportCommenter(data.commenter.id)
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url
      link.download = exportFileName(data.commenter.id)
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Later: revoking at once can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success("Exported. The file holds the address and every comment.")
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't export the commenter"))
    } finally {
      setExporting(false)
    }
  }

  const runErase = async () => {
    if (!data) return
    setErasing(true)
    try {
      const result = await eraseCommenter(data.commenter.id)
      setConfirmErase(false)
      toast.success(erasedMessage(result))
      announceDiscussionChanged()
      navigate("/discussion")
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't erase the commenter"))
      setErasing(false)
    }
  }

  const crumb = (
    <nav className="gl-dq-crumb" aria-label="Breadcrumb">
      <Link to="/discussion">Discussion</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{data?.commenter.name ?? "Commenter"}</span>
    </nav>
  )

  if (error) {
    const gone = error instanceof ApiError && error.status === 404
    return (
      <section className="gl-content-list gl-discussion">
        {crumb}
        <h1 className="gl-dq-commenter__name">{gone ? "Commenter not found" : "Commenter"}</h1>
        {gone ? (
          <EmptyState
            title="This commenter isn't here anymore"
            description="Their data was erased, or they had no comments left."
            action={
              <Link to="/discussion" className={buttonClassName("secondary", "md")}>
                Back to Discussion
              </Link>
            }
          />
        ) : (
          <EmptyState
            variant="error"
            icon="close"
            title="This commenter didn't load"
            description={errorMessage(error)}
            action={
              <Button variant="primary" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        )}
      </section>
    )
  }

  if (!data) {
    return (
      <section className="gl-content-list gl-discussion">
        {crumb}
        <span role="status" className="gl-content-list__sr">
          Loading the commenter…
        </span>
        <div className="gl-dq-commenter__head" aria-hidden="true">
          <Skeleton shape="circle" width={56} height={56} />
          <div>
            <Skeleton shape="text" width={200} />
            <Skeleton shape="text" width={260} />
          </div>
        </div>
      </section>
    )
  }

  const c = data.commenter
  const otherNames = c.names_used.filter((n) => n !== c.name)
  const blocked = blockedLine(c)
  const network = networkLine(c.network_neighbours)
  return (
    <section className="gl-content-list gl-discussion">
      {crumb}
      <header className="gl-dq-commenter__head">
        <Avatar user={{ id: c.id, name: c.name }} size={64} decorative />
        <div className="gl-dq-commenter__who">
          <h1 className="gl-dq-commenter__name">{c.name}</h1>
          <span>{c.email}</span>
          <span className="gl-dq-help">
            {[
              c.verified_at ? `Verified ${day(c.verified_at)}` : "Not verified",
              otherNames.length ? `also posted as ${otherNames.map((n) => `“${n}”`).join(", ")}` : null,
              `first seen ${day(c.created_at)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="gl-dq-commenter__actions">
          <Button variant="secondary" loading={busy} onClick={() => void toggleBlock()}>
            {c.blocked_at ? "Unblock" : "Block"}
          </Button>
          {admin && (
            <>
              <Button variant="secondary" loading={exporting} onClick={() => void runExport()}>
                Export
              </Button>
              <Button variant="danger" onClick={() => setConfirmErase(true)}>
                Erase
              </Button>
            </>
          )}
        </div>
      </header>

      <Modal
        isOpen={confirmErase}
        onClose={() => !erasing && setConfirmErase(false)}
        role="alertdialog"
        size="small"
        title={eraseConfirm(c).title}
        description={eraseConfirm(c).body}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmErase(false)} disabled={erasing}>
              Cancel
            </Button>
            <Button variant="danger" loading={erasing} onClick={() => void runErase()}>
              {eraseConfirm(c).button}
            </Button>
          </>
        }
      >
        <p className="gl-dq-help">{c.email}</p>
      </Modal>

      {blocked && (
        <Notice tone="warning" title={blocked}>
          New comments from this address go straight to Spam, and it gets no mail but confirmations. Comments already published stay until you remove them.
        </Notice>
      )}

      <dl className="gl-dq-stats">
        {(
          [
            ["Approved", c.approved],
            ["Pending", c.pending],
            ["Spam", c.spam],
            ["Trash", c.trash],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="gl-dq-stat">
            <dt>{label}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>

      <section className="gl-dq-commenter__section" aria-labelledby="gl-dq-comments-h">
        <h2 id="gl-dq-comments-h">Comments</h2>
        {data.comments.length === 0 ? (
          <p className="gl-dq-help">No comments left.</p>
        ) : (
          <ul className="gl-dq-list">
            {data.comments.map((comment) => (
              <li key={comment.id} className="gl-dq-row gl-dq-row--plain">
                <div className="gl-dq-row__body">
                  <div className="gl-dq-who">
                    <Pill tone={TONES[comment.status] ?? "neutral"} dot={false}>
                      {STATUS_LABELS[comment.status]}
                    </Pill>
                    <span className="gl-dq-meta">
                      <span>
                        On{" "}
                        <a href={comment.post.url} target="_blank" rel="noopener noreferrer">
                          {comment.post.title || "Untitled"}
                        </a>
                      </span>
                      <time dateTime={comment.created_at}>{formatLastEdited(comment.created_at)}</time>
                    </span>
                  </div>
                  <p className="gl-dq-text">{comment.body}</p>
                  <div className="gl-dq-meta">
                    <Link to={`/discussion?${new URLSearchParams({ status: comment.status, comment: String(comment.id) })}`}>View thread</Link>
                    {comment.notify_replies && <span>Emails replies</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="gl-dq-cards">
        <section className="gl-dq-card" aria-labelledby="gl-dq-mail-h">
          <h2 id="gl-dq-mail-h">Mail</h2>
          <p>{mailLine(c.notify_count)}</p>
          <p className="gl-dq-help">Asked for with “Email me replies”. Every mail has an unsubscribe link.</p>
        </section>
        <section className="gl-dq-card" aria-labelledby="gl-dq-net-h">
          <h2 id="gl-dq-net-h">Network</h2>
          <p>{network ? `${network.replace("from this network", "posted from this network")} in the last 30 days.` : "No other commenters from this network."}</p>
          <p className="gl-dq-help">A keyed hash, never the address. It goes after 30 days.</p>
        </section>
      </div>
    </section>
  )
}
