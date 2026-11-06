import React, { useCallback, useEffect, useRef, useState } from "react"
import Input from "@gl-admin/components/ui/Input"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Notice from "@gl-admin/components/ui/Notice"
import Modal from "@gl-admin/components/ui/Modal"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Avatar from "@gl-admin/components/ui/Avatar"
import { toast } from "@gl-admin/components/ui/Toast"
import { TrashIcon } from "@gl-admin/components/ui/icons"
import { createRedirect, deleteRedirect, listRedirects, type Redirect } from "@gl-admin/lib/api/redirects"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { formatLastEdited } from "@gl-admin/lib/contentList"
import { formatFullDate } from "@gl-admin/utils/formatting"
import {
  appendRedirects,
  creatorName,
  normalizeFrom,
  normalizeTo,
  redirectCount,
  redirectErrorMessage,
  sourceDescription,
  statusLabel,
  validateRedirect,
  type RedirectErrors,
} from "@gl-admin/lib/redirects"
import "@gl-admin/assets/styles/components/ui/table.scss"
import "@gl-admin/assets/styles/pages/redirects.scss"

const PAGE_SIZE = 20

const STATUS_OPTIONS = [
  { value: "301", label: "Permanent (301)", description: "The address moved for good. Search engines update their links." },
  { value: "302", label: "Temporary (302)", description: "The old address comes back later. Search engines keep it." },
]

// Settings › URLs & redirects (#331, the board's isUrls section). Outside the settings
// form: it saves at once, not through the unsaved-changes bar, and Enter here adds a
// redirect. Admins only (the page is). Rules and wording: lib/redirects.ts.
export default function RedirectsSection() {
  const [redirects, setRedirects] = useState<Redirect[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [status, setStatus] = useState("301")
  const [errors, setErrors] = useState<RedirectErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [deleting, setDeleting] = useState<Redirect | null>(null)
  const fromRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const page = await listRedirects({ limit: PAGE_SIZE, offset: 0 })
      setRedirects(page.redirects)
      setTotal(page.total)
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const loadMore = async () => {
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await listRedirects({ limit: PAGE_SIZE, offset: redirects.length })
      setRedirects((prev) => appendRedirects(prev, page.redirects))
      setTotal(page.total)
    } catch (error) {
      setMoreError(errorMessage(error))
    } finally {
      setLoadingMore(false)
    }
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const invalid = validateRedirect(from, to)
    setErrors(invalid)
    setFormError(null)
    if (invalid.from || invalid.to) return
    setAdding(true)
    try {
      const redirect = await createRedirect({
        from_path: normalizeFrom(from),
        to_path: normalizeTo(to),
        status_code: status === "302" ? 302 : 301,
      })
      if (redirect) {
        setRedirects((prev) => [redirect, ...prev.filter((r) => r.id !== redirect.id)])
        setTotal((n) => n + 1)
      } else {
        load()
      }
      setFrom("")
      setTo("")
      setStatus("301")
      toast.success("Redirect added")
      fromRef.current?.focus()
    } catch (error) {
      const { field, message } = redirectErrorMessage(error, from)
      if (field) setErrors({ [field]: message })
      else setFormError(message)
    } finally {
      setAdding(false)
    }
  }

  const removeRow = (id: number) => {
    setRedirects((prev) => prev.filter((r) => r.id !== id))
    setTotal((n) => Math.max(0, n - 1))
  }

  const renderList = () => {
    if (loadError) {
      return (
        <EmptyState
          variant="error"
          compact
          icon="close"
          title="Couldn't load redirects"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={load}>
              Try again
            </Button>
          }
        />
      )
    }
    if (loading) {
      return (
        <div className="gl-redirects__loading" aria-busy="true">
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      )
    }
    if (redirects.length === 0) {
      return (
        <EmptyState
          compact
          icon="content"
          title="No redirects yet"
          description="Add one when you move or rename a page. GoLive adds them itself when a slug changes or tags are merged."
        />
      )
    }
    return (
      <>
        <div className="gl-table-scroll">
          <table className="gl-table gl-redirects__table" aria-labelledby="gl-redirects-count">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col" className="gl-redirects__by-col">
                  Created by
                </th>
                <th scope="col" className="gl-redirects__action-col">
                  <span className="gl-workspace__sr">Delete</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {redirects.map((r) => (
                <RedirectRow key={r.id} redirect={r} onDelete={() => setDeleting(r)} />
              ))}
            </tbody>
          </table>
        </div>
        {moreError && (
          <Notice tone="danger" live="alert">
            {moreError}
          </Notice>
        )}
        {redirects.length < total && (
          <Button variant="secondary" className="gl-redirects__more" onClick={loadMore} loading={loadingMore}>
            Show more
          </Button>
        )}
      </>
    )
  }

  return (
    <section className="gl-workspace__section gl-redirects" id="gl-settings-urls" aria-labelledby="gl-settings-urls-h">
      <div>
        <h2 className="gl-workspace__section-title" id="gl-settings-urls-h">
          URLs &amp; redirects
        </h2>
        <p className="gl-workspace__section-intro">Send an old address to a new one, so saved links and search results keep working.</p>
      </div>

      <form className="gl-redirects__add" aria-label="Add a redirect" onSubmit={handleAdd} noValidate>
        <div className="gl-redirects__fields">
          <Input
            ref={fromRef}
            title="From"
            unmasked
            name="redirect_from"
            id="gl-redirect-from"
            placeholder="/blog/old-address"
            spellCheck={false}
            autoCapitalize="off"
            containerClassName="gl-redirects__field"
            value={from}
            error={errors.from}
            onChange={(e) => {
              setFrom(e.target.value)
              setErrors((prev) => ({ ...prev, from: undefined }))
            }}
          />
          <span className="gl-redirects__arrow" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <Input
            title="To"
            unmasked
            name="redirect_to"
            id="gl-redirect-to"
            placeholder="/blog/new-address or https://…"
            spellCheck={false}
            autoCapitalize="off"
            containerClassName="gl-redirects__field"
            value={to}
            error={errors.to}
            onChange={(e) => {
              setTo(e.target.value)
              setErrors((prev) => ({ ...prev, to: undefined }))
            }}
          />
          <Button type="submit" variant="primary" loading={adding} className="gl-redirects__submit">
            Add redirect
          </Button>
        </div>
        <RadioGroup legend="Type" className="gl-redirects__status" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
        {formError && (
          <Notice tone="danger" live="alert">
            {formError}
          </Notice>
        )}
      </form>

      <div className="gl-redirects__list">
        {!loading && !loadError && redirects.length > 0 && (
          <h3 className="gl-redirects__count" id="gl-redirects-count">
            {redirectCount(total)}
          </h3>
        )}
        {renderList()}
      </div>

      <DeleteRedirectModal
        redirect={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          setDeleting(null)
          removeRow(id)
          toast.success("Redirect deleted")
        }}
      />
    </section>
  )
}

function RedirectRow({ redirect: r, onDelete }: { redirect: Redirect; onDelete: () => void }) {
  const automatic = sourceDescription(r.source)
  const name = creatorName(r)
  return (
    <tr>
      <td className="gl-redirects__path">{r.from_path}</td>
      <td className="gl-redirects__path">
        <span className="gl-redirects__to">
          <span className="gl-redirects__to-path">{r.to_path}</span>
          {r.external && <span className="gl-workspace__badge">External</span>}
          {r.status_code === 302 && (
            <span className="gl-workspace__badge" title="Temporary redirect (302)">
              302<span className="gl-workspace__sr"> {statusLabel(302).toLowerCase()}</span>
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="gl-redirects__by">
          {r.created_by ? (
            <Avatar user={{ id: r.created_by.id, name, src: r.created_by.avatar }} size={24} decorative />
          ) : (
            <span className="gl-redirects__no-avatar" aria-hidden="true" />
          )}
          <span className="gl-redirects__by-text">
            <span>{name}</span>
            <span className="gl-redirects__when">
              <time dateTime={r.created_at} title={formatFullDate(r.created_at)}>
                {formatLastEdited(r.created_at)}
              </time>
              {automatic && r.created_by && (
                <span title={automatic}>
                  {" · "}Automatic<span className="gl-workspace__sr">: {automatic.toLowerCase()}</span>
                </span>
              )}
              {automatic && !r.created_by && <span className="gl-workspace__sr">, {automatic.toLowerCase()}</span>}
            </span>
          </span>
        </span>
      </td>
      <td className="gl-redirects__action">
        <IconButton
          size="sm"
          variant="ghost"
          className="gl-redirects__delete"
          aria-label={`Delete redirect from ${r.from_path}`}
          icon={<TrashIcon />}
          onClick={onDelete}
        />
      </td>
    </tr>
  )
}

function DeleteRedirectModal({
  redirect,
  onClose,
  onDeleted,
}: {
  redirect: Redirect | null
  onClose: () => void
  onDeleted: (id: number) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [redirect?.id])

  if (!redirect) return null

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    try {
      await deleteRedirect(redirect.id)
      onDeleted(redirect.id)
    } catch (err) {
      // Someone deleted it already: the result is the same.
      if (err instanceof ApiError && err.status === 404) onDeleted(redirect.id)
      else setError(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  const footer = (
    <div className="gl-redirects__dialog-footer">
      <Button variant="secondary" onClick={onClose} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="danger" onClick={handleDelete} loading={deleting}>
        Delete redirect
      </Button>
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title="Delete this redirect?" size="small" footer={footer} role="alertdialog">
      <div className="gl-workspace__form">
        <p className="gl-redirects__confirm">
          <span className="gl-workspace__mono">{redirect.from_path}</span> will stop sending visitors to{" "}
          <span className="gl-workspace__mono">{redirect.to_path}</span>. Saved links to the old address may then show “Page not found”.
        </p>
        {error && (
          <Notice tone="danger" live="alert">
            {error}
          </Notice>
        )}
      </div>
    </Modal>
  )
}
