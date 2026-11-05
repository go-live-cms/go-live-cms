import { useEffect, useRef, useState } from "react"
import Notice from "@gl-admin/components/ui/Notice"
import Button from "@gl-admin/components/ui/Button"
import Modal from "@gl-admin/components/ui/Modal"
import Textarea from "@gl-admin/components/ui/Textarea"
import Avatar from "@gl-admin/components/ui/Avatar"
import { toast } from "@gl-admin/components/ui/Toast"
import {
  declineAccessRequest,
  grantAccessRequest,
  requestPostAccess,
  revokePostAccess,
  type AccessRequest,
  type PostAccess,
  type PostCollaborator,
} from "@gl-admin/lib/api/postAccess"
import { ACCESS_REQUEST_MESSAGE_MAX, accessErrorMessage, memberName, requestTitle, viewOnlyNotice } from "@gl-admin/lib/postAccess"

// Edit access requests (#321; "Editor menus & states" › Presence & permissions on the
// redesign canvas). The view-only notice's Request access, the reviewers' notice with
// Grant / Decline, and the post settings' list of who has edit access (Remove). Every
// change calls `onChanged`, which re-reads GET /posts/:id/access. A grant reaches the
// requester's open editor through the collab server's re-check (#313): the editor turns
// editable without a reload.

// How often a pending request's notice re-reads GET /posts/:id/access.
export const PENDING_REFRESH_MS = 30_000

// The view-only notice for someone who can't edit the post, with Request access when
// they may ask (a contributor watching someone else's published post).
export function ViewOnlyNotice({ postId, access, onChanged }: { postId: number; access: PostAccess | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notice = viewOnlyNotice(access)
  const tooLong = [...message].length > ACCESS_REQUEST_MESSAGE_MAX

  // A grant reaches this editor through the collab re-check (an access message), but a
  // decline changes nothing on the connection: while the request waits, look again now
  // and then so "Request sent" turns into the answer.
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const waiting = notice.action === "sent"
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => onChangedRef.current(), PENDING_REFRESH_MS)
    return () => clearInterval(timer)
  }, [waiting])

  const close = () => {
    if (sending) return
    setOpen(false)
    setError(null)
  }
  const send = async () => {
    if (tooLong) return
    setSending(true)
    setError(null)
    try {
      await requestPostAccess(postId, message)
      setOpen(false)
      setMessage("")
      toast.success("Request sent")
      onChanged()
    } catch (e) {
      setError(accessErrorMessage(e))
      // An open or declined request found by the API: show it.
      onChanged()
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Notice
        tone="info"
        live="status"
        inline
        className="post-editor__notice"
        actions={
          notice.action === "request" ? (
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
              Request access
            </Button>
          ) : notice.action === "sent" ? (
            <Button variant="secondary" size="sm" disabled>
              Request sent
            </Button>
          ) : undefined
        }
      >
        <strong>View-only:</strong> {notice.message}
      </Notice>
      <Modal
        isOpen={open}
        onClose={close}
        size="medium"
        title="Request edit access"
        description="The post's owner and the editors are asked, by email and on their Home. Once one of them grants it, you can edit here."
        closeOnBackdrop={!message}
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={sending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={send} loading={sending} disabled={tooLong}>
              Send request
            </Button>
          </>
        }
      >
        <Textarea
          label="Message"
          optional
          maxCount={ACCESS_REQUEST_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          hint="Say what you'd like to change."
          error={error ?? (tooLong ? `Keep it under ${ACCESS_REQUEST_MESSAGE_MAX} characters.` : undefined)}
          rows={4}
        />
      </Modal>
    </>
  )
}

// The open requests, for whoever may answer them (the owner, editors, admins).
export function AccessRequestsNotice({ postId, pending, onChanged }: { postId: number; pending: AccessRequest[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  if (pending.length === 0) return null

  const answer = async (request: AccessRequest, grant: boolean) => {
    setBusy(request.id)
    try {
      await (grant ? grantAccessRequest(postId, request.id) : declineAccessRequest(postId, request.id))
      const name = memberName(request.requester)
      toast.success(grant ? `${name} can edit this post now` : `Declined ${name}'s request`)
    } catch (e) {
      toast.error(accessErrorMessage(e))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  return (
    <div className="post-editor__access-requests">
      {pending.map((request) => (
        <Notice
          key={request.id}
          tone="info"
          live="status"
          className="post-editor__notice"
          title={requestTitle(request)}
          actions={
            <>
              <Button variant="primary" size="sm" loading={busy === request.id} disabled={busy !== null} onClick={() => answer(request, true)}>
                Grant
              </Button>
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => answer(request, false)}>
                Decline
              </Button>
            </>
          }
        >
          {request.message ? <q className="post-editor__access-message">{request.message}</q> : "They'd like to edit this post."}{" "}
          Edit access lets them change the content; it goes live when an editor publishes.
        </Notice>
      ))}
    </div>
  )
}

// Who has edit access through a grant (post settings), with Remove for reviewers.
export function PostCollaborators({ postId, collaborators, onChanged }: { postId: number; collaborators: PostCollaborator[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null)
  const revoke = async (member: PostCollaborator) => {
    setBusy(member.id)
    try {
      await revokePostAccess(postId, member.id)
      toast.success(`${memberName(member)} can no longer edit this post`)
    } catch (e) {
      toast.error(accessErrorMessage(e))
    } finally {
      setBusy(null)
      onChanged()
    }
  }
  return (
    <ul className="post-settings__collaborators">
      {collaborators.map((member) => (
        <li key={member.id} className="post-settings__collaborator">
          <Avatar user={{ id: member.id, name: memberName(member), src: member.avatar }} size={24} decorative />
          <span className="post-settings__collaborator-name">{memberName(member)}</span>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === member.id}
            disabled={busy !== null}
            onClick={() => revoke(member)}
            aria-label={`Remove ${memberName(member)}'s edit access`}
          >
            Remove
          </Button>
        </li>
      ))}
    </ul>
  )
}
