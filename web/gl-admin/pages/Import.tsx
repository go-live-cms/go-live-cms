import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Pill from "@gl-admin/components/ui/Pill"
import Select from "@gl-admin/components/ui/Select"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Tabs from "@gl-admin/components/ui/Tabs"
import { toast } from "@gl-admin/components/ui/Toast"
import { CheckIcon, CloseIcon, UploadIcon } from "@gl-admin/components/ui/icons"
import { allMembers } from "@gl-admin/components/users/MemberPicker"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import {
  cancelImport,
  deleteImport,
  getImport,
  listImportItems,
  listImportMediaFailures,
  listImports,
  startImport,
  uploadImport,
  type ImportItem,
  type ImportJob,
  type ImportListItem,
  type ImportMapping,
  type ImportMediaFailureRow,
} from "@gl-admin/lib/api/imports"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import type { PostType, User } from "@gl-admin/lib/api/types"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import { memberOptions } from "@gl-admin/lib/members"
import { canOwnPosts } from "@gl-admin/lib/postOwner"
import {
  IMPORT_ACCEPT,
  IMPORT_HELP,
  IMPORT_POLL_MS,
  IMPORTER_CHOICE,
  STATUS_LABELS,
  STATUS_TONES,
  authorMeta,
  defaultMapping,
  droppedTitle,
  droppedWhere,
  exportTypeLabel,
  finishedTitle,
  importCount,
  isActive,
  itemMeta,
  noteTexts,
  originalText,
  previewSentence,
  progressDetail,
  progressLine,
  progressPercent,
  reasonText,
  recentMeta,
  reportSummary,
  reportTabs,
  skippedSentence,
  sourceLabel,
  tabQuery,
  typeChoices,
  typeMeta,
  type ReportTab,
} from "@gl-admin/lib/imports"
import "@gl-admin/assets/styles/pages/import.scss"

// Posts › Import (#150; the canvas's "Posts · Import" board), admins only. Without ?id=:
// choose a file (a WordPress export or a zip of Markdown files) and the recent imports.
// With ?id=: the import's step: map authors and content types (with what will be
// imported), then its progress while the server runs it (safe to leave: the page polls),
// then its report. Rules and wording: lib/imports.ts.

export default function Import() {
  usePageTitle("Import")
  const [params, setParams] = useSearchParams()
  const id = Number(params.get("id")) || null
  const open = useCallback((jobId: number | null) => setParams(jobId ? { id: String(jobId) } : {}), [setParams])
  return (
    <section className="gl-import">
      {id ? <ImportJobView id={id} onOpen={open} /> : <ChooseFile onOpen={open} />}
    </section>
  )
}

function ChooseFile({ onOpen }: { onOpen: (id: number) => void }) {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ message: string; file: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [recent, setRecent] = useState<ImportListItem[] | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    listImports()
      .then((list) => live && setRecent(list))
      .catch(() => live && setRecent([]))
    return () => {
      live = false
    }
  }, [])

  const upload = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const job = await uploadImport(file)
      onOpen(job.id)
    } catch (error) {
      const message = error instanceof ApiError ? error.serverMessage || error.message : errorMessage(error)
      setRefusal({ message, file: file.name })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ""
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void upload(event.dataTransfer.files?.[0])
  }

  return (
    <>
      <header className="gl-import__header">
        <h1>Import</h1>
        <p>Bring posts, pages, categories, tags and images over from WordPress or a Markdown export.</p>
      </header>
      <div
        className={`gl-import__drop${dragging ? " is-dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        aria-busy={busy}
      >
        <UploadIcon size={28} />
        <span className="gl-import__drop-title">Drop a WordPress export (.xml) or a zip of Markdown files</span>
        <input
          ref={input}
          id="gl-import-file"
          type="file"
          accept={IMPORT_ACCEPT}
          className="gl-import__file"
          onChange={(e) => void upload(e.target.files?.[0])}
          disabled={busy}
        />
        <Button variant="primary" onClick={() => input.current?.click()} loading={busy} disabled={busy}>
          {busy ? "Reading the file…" : "Choose file"}
        </Button>
        <span className="gl-import__hint">{IMPORT_HELP} Up to 100 MB.</span>
      </div>
      {refusal && (
        <Notice tone="danger" live="alert" title={refusal.message}>
          <span className="gl-import__mono">{refusal.file}</span>
        </Notice>
      )}
      <div className="gl-import__recent">
        <h2>Recent imports</h2>
        {recent === null ? (
          <Skeleton shape="text" width={240} />
        ) : recent.length === 0 ? (
          <p className="gl-import__muted">No imports yet.</p>
        ) : (
          <ul className="gl-import__list">
            {recent.map((job) => (
              <li key={job.id}>
                <span className="gl-import__list-main">
                  <Link to={`/import?id=${job.id}`}>{job.file_name}</Link>
                  <span className="gl-import__muted">{recentMeta(job)}</span>
                </span>
                <Pill tone={STATUS_TONES[job.status]}>{STATUS_LABELS[job.status]}</Pill>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function ImportJobView({ id, onOpen }: { id: number; onOpen: (id: number | null) => void }) {
  const [job, setJob] = useState<ImportJob | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await getImport(id)
        if (!live) return
        setJob(next)
        setLoadError(null)
        if (isActive(next.status)) timer = setTimeout(load, IMPORT_POLL_MS)
      } catch (error) {
        if (!live) return
        setLoadError(error)
        timer = setTimeout(load, IMPORT_POLL_MS * 4)
      }
    }
    void load()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [id, job?.status])

  if (!job) {
    return loadError ? (
      <Notice tone="danger" title="The import couldn’t be loaded" actions={<Button onClick={() => onOpen(null)}>Back to Import</Button>}>
        {errorMessage(loadError)}
      </Notice>
    ) : (
      <Skeleton shape="text" width={320} />
    )
  }
  if (job.status === "mapping") return <MappingStep job={job} onStarted={setJob} onOpen={onOpen} />
  if (isActive(job.status)) return <ProgressStep job={job} onChanged={setJob} />
  return <ReportStep job={job} onOpen={onOpen} />
}

function JobHeader({ job, title }: { job: ImportJob; title: string }) {
  return (
    <header className="gl-import__header">
      <h1>{title}</h1>
      <p>
        <span className="gl-import__mono">{job.file_name}</span>
        {job.summary.site_host ? ` · ${job.summary.site_host}` : ""}
      </p>
    </header>
  )
}

function MappingStep({ job, onStarted, onOpen }: { job: ImportJob; onStarted: (job: ImportJob) => void; onOpen: (id: number | null) => void }) {
  const me = useAuthUser()
  const navigate = useNavigate()
  const summary = job.summary
  const [mapping, setMapping] = useState<ImportMapping>(() => defaultMapping(summary))
  const [members, setMembers] = useState<User[] | null>(null)
  const [postTypes, setPostTypes] = useState<PostType[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    allMembers()
      .then((list) => live && setMembers(list))
      .catch(() => live && setMembers([]))
    getPostTypes()
      .then((r) => live && setPostTypes(r.data.filter((t) => (t as PostType & { is_active?: boolean }).is_active !== false)))
      .catch(() => live && setPostTypes([]))
    return () => {
      live = false
    }
  }, [])

  const memberChoices = useMemo(() => {
    const self = IMPORTER_CHOICE(me?.full_name || me?.username || "you")
    const others = memberOptions(members ?? [], { me: null, exclude: me ? [me.id] : [], eligible: canOwnPosts })
    return [self, ...others]
  }, [members, me])
  const types = useMemo(() => typeChoices(postTypes ?? [{ name: "post", label: "Posts" }, { name: "page", label: "Pages" }]), [postTypes])
  const typeLabels = useMemo(() => Object.fromEntries(types.map((t) => [t.value, t.label])), [types])
  const count = importCount(summary, mapping)
  const skipped = skippedSentence(summary, mapping, job.imported_before ?? 0)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      onStarted(await startImport(job.id, mapping))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const discard = async () => {
    try {
      await deleteImport(job.id)
      onOpen(null)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <JobHeader job={job} title={`Import from ${sourceLabel(summary.source)}`} />
      {summary.authors.length > 0 && (
        <fieldset className="gl-import__fieldset">
          <legend>Authors</legend>
          <p className="gl-import__muted">Who owns each author’s posts here. Matched by email or user name where a member has the same one.</p>
          {summary.authors.map((author) => (
            <div className="gl-import__row" key={author.login}>
              <span className="gl-import__row-label">
                <span>{author.display_name}</span>
                <span className="gl-import__muted">{authorMeta(author)}</span>
              </span>
              <Select
                label={`Owner of ${author.display_name}’s posts`}
                options={memberChoices}
                value={String(mapping.authors[author.login] ?? 0)}
                onChange={(value) => setMapping((m) => ({ ...m, authors: { ...m.authors, [author.login]: Number(value) } }))}
                disabled={members === null}
              />
            </div>
          ))}
        </fieldset>
      )}
      <fieldset className="gl-import__fieldset">
        <legend>Content types</legend>
        {summary.types.map((t) => (
          <div className="gl-import__row" key={t.type}>
            <span className="gl-import__row-label">
              <span>{exportTypeLabel(t.type)}</span>
              <span className="gl-import__muted">{typeMeta(t)}</span>
            </span>
            <Select
              label={`Import ${exportTypeLabel(t.type)} as`}
              options={types}
              value={mapping.types[t.type] ?? ""}
              onChange={(value) => setMapping((m) => ({ ...m, types: { ...m.types, [t.type]: value } }))}
            />
          </div>
        ))}
      </fieldset>
      <div className="gl-import__preview">
        <h2>What will be imported</h2>
        <p aria-live="polite">{previewSentence(summary, mapping, typeLabels)}</p>
        {skipped && <p className="gl-import__muted">{skipped}</p>}
      </div>
      {error && (
        <Notice tone="danger" live="alert">
          {error}
        </Notice>
      )}
      <div className="gl-import__actions">
        <Button variant="ghost" onClick={() => void discard()} disabled={busy}>
          Discard
        </Button>
        <Button variant="ghost" onClick={() => navigate("/import")} disabled={busy}>
          Later
        </Button>
        <Button variant="primary" onClick={() => void start()} loading={busy} disabled={busy || count === 0}>
          {count === 1 ? "Import 1 item" : `Import ${count.toLocaleString("en-US")} items`}
        </Button>
      </div>
    </>
  )
}

function ProgressStep({ job, onChanged }: { job: ImportJob; onChanged: (job: ImportJob) => void }) {
  const [stopping, setStopping] = useState(false)
  const percent = progressPercent(job)
  const stop = async () => {
    setStopping(true)
    try {
      onChanged(await cancelImport(job.id))
    } catch (e) {
      toast.error(errorMessage(e))
      setStopping(false)
    }
  }
  return (
    <>
      <JobHeader job={job} title={`Importing from ${sourceLabel(job.summary.source)}`} />
      <div className="gl-import__progress">
        <div className="gl-import__progress-line">
          <span role="status">{job.status === "queued" ? "Waiting to start…" : progressLine(job)}</span>
          <span className="gl-import__muted">{progressDetail(job)}</span>
        </div>
        <div
          className="gl-import__bar"
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={job.progress.total}
          aria-valuenow={job.progress.total - job.progress.pending}
        >
          <div style={{ width: `${percent}%` }} />
        </div>
      </div>
      <Notice tone="info" live="none">
        You can leave this page. The import keeps running, and its report waits here. Stopping keeps what’s imported;
        running the file again skips it.
      </Notice>
      <div className="gl-import__actions">
        <Button variant="secondary" onClick={() => void stop()} loading={stopping} disabled={stopping}>
          Stop import
        </Button>
      </div>
    </>
  )
}

const REPORT_PAGE = 100

function ReportStep({ job, onOpen }: { job: ImportJob; onOpen: (id: number | null) => void }) {
  const tabs = reportTabs(job)
  const [tab, setTab] = useState<ReportTab>("all")
  const [items, setItems] = useState<ImportItem[] | null>(null)
  const [more, setMore] = useState(false)
  const [media, setMedia] = useState<ImportMediaFailureRow[]>([])

  useEffect(() => {
    let live = true
    setItems(null)
    listImportItems(job.id, { ...tabQuery(tab), limit: REPORT_PAGE })
      .then((list) => {
        if (!live) return
        setItems(list)
        setMore(list.length === REPORT_PAGE)
      })
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [job.id, tab])

  // Failed images are listed for the whole import, whatever the tab (the API's list).
  useEffect(() => {
    let live = true
    listImportMediaFailures(job.id)
      .then((list) => live && setMedia(list))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [job.id])

  const loadMore = async () => {
    const next = await listImportItems(job.id, { ...tabQuery(tab), limit: REPORT_PAGE, offset: items?.length ?? 0 })
    setItems((cur) => [...(cur ?? []), ...next])
    setMore(next.length === REPORT_PAGE)
  }

  return (
    <>
      <header className="gl-import__header gl-import__header--row">
        <div>
          <h1>{finishedTitle(job.status)}</h1>
          <p>
            <span className="gl-import__mono">{job.file_name}</span>
            {job.summary.site_host ? ` · ${job.summary.site_host}` : ""}
          </p>
        </div>
        <div className="gl-import__header-actions">
          <Link className="gl-button gl-button--secondary" to="/content/post">
            View posts
          </Link>
          <Button variant="primary" onClick={() => onOpen(null)}>
            Import another file
          </Button>
        </div>
      </header>
      <p role="status" className="gl-import__summary">
        {reportSummary(job, job.progress.media_failed ?? media.length)}
      </p>
      <Tabs label="Report" tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: t.count }))} value={tab} onChange={(t) => setTab(t as ReportTab)} activation="manual" />
      {items === null ? (
        <Skeleton shape="text" width={320} />
      ) : items.length === 0 ? (
        <p className="gl-import__muted">Nothing here.</p>
      ) : (
        <ul className="gl-import__report">
          {items.map((item) => (
            <ReportRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {more && (
        <Button variant="ghost" onClick={() => void loadMore()}>
          Show more
        </Button>
      )}
      {media.length > 0 && (
        <div className="gl-import__media">
          <h2>Images that couldn’t be added</h2>
          <ul className="gl-import__list">
            {media.map((m, i) => (
              <li key={i}>
                <CloseIcon size={16} className="gl-import__icon--danger" />
                <span className="gl-import__list-main">
                  <span className="gl-import__danger">{m.reason}</span>
                  <span className="gl-import__mono gl-import__muted">
                    {m.url} · in “{m.post}”
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function ReportRow({ item }: { item: ImportItem }) {
  const dropped = item.result?.dropped ?? []
  const notes = item.status === "imported" ? noteTexts(item) : []
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(originalText(dropped))
      toast.success("Copied the original")
    } catch {
      toast.error("Couldn’t copy to the clipboard")
    }
  }
  return (
    <li className={`gl-import__item gl-import__item--${item.status}`}>
      <div className="gl-import__item-line">
        {item.status === "imported" ? (
          <CheckIcon size={16} className="gl-import__icon--success" />
        ) : item.status === "failed" ? (
          <CloseIcon size={16} className="gl-import__icon--danger" />
        ) : (
          <span className="gl-import__icon--dash" aria-hidden="true" />
        )}
        {item.post_id && item.post_status ? (
          <Link to={`/content/edit/${item.post_id}`} className="gl-import__item-title">
            {item.title || "Untitled"}
          </Link>
        ) : (
          <span className="gl-import__item-title">{item.title || "Untitled"}</span>
        )}
        <span className={item.status === "failed" ? "gl-import__danger" : "gl-import__muted"}>
          {item.status === "imported" ? itemMeta(item) : `${itemMeta(item)} · ${reasonText(item)}`}
        </span>
      </div>
      {notes.length > 0 && (
        <ul className="gl-import__notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {dropped.length > 0 && (
        <div className="gl-import__dropped" role="group" aria-label={droppedTitle(dropped.length)}>
          <strong>{droppedTitle(dropped.length)}</strong>
          <ul>
            {dropped.map((d, i) => (
              <li key={i}>
                {d.label} <span className="gl-import__dropped-where">— {droppedWhere(d.after)}</span>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            Copy the original as text
          </Button>
        </div>
      )}
    </li>
  )
}
