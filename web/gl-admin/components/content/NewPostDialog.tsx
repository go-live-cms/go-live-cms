import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import Modal from "@gl-admin/components/ui/Modal"
import Input from "@gl-admin/components/ui/Input"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Menu, { MenuItem } from "@gl-admin/components/ui/Menu"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { toast } from "@gl-admin/components/ui/Toast"
import { ChevronRightIcon, DocumentIcon, MoreIcon, PencilIcon } from "@gl-admin/components/ui/icons"
import {
  createPostFromTemplate,
  deletePostTemplate,
  listPostTemplates,
  renamePostTemplate,
  type PostTemplate,
} from "@gl-admin/lib/api/postTemplates"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  TEMPLATE_NAME_MAX,
  deletedTemplateMessage,
  fromTemplateMessage,
  templateNameConflict,
  templateNameError,
  templateSummary,
} from "@gl-admin/lib/postTemplates"
import "@gl-admin/assets/styles/components/content/templates.scss"

// "New post: Blank or from a template" (#322, Home on the redesign canvas): Blank opens
// the editor on a new post as before; a template makes a draft you own with its content
// (and its saved category and featured image) and opens it. Admins and editors also
// rename and delete templates here: the templates manager is this list, so there is
// one place that shows them. Templates are saved from a post's row menu.

type NewPostDialogProps = {
  isOpen: boolean
  onClose: () => void
  // The post type the new post gets, and its singular for the wording ("post", "page").
  postType: string
  noun: string
  // Admins and editors: rename and delete (the API's rule).
  canManage: boolean
}

// The lists' New button (Posts, Pages, any type): the chooser when the type has
// templates, else straight to a blank post as before. The check runs again whenever
// the chooser closes, so deleting the last template there takes effect.
export function useNewPostChooser({ postType, noun, canCreate, canManage }: { postType: string; noun: string; canCreate: boolean; canManage: boolean }) {
  const navigate = useNavigate()
  const [hasTemplates, setHasTemplates] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!canCreate || open) return
    let live = true
    listPostTemplates(postType)
      .then((templates) => live && setHasTemplates(templates.length > 0))
      .catch(() => live && setHasTemplates(false))
    return () => {
      live = false
    }
  }, [postType, canCreate, open])

  const start = () => (hasTemplates ? setOpen(true) : navigate(`/content/${postType}/new`))
  const dialog = <NewPostDialog isOpen={open} onClose={() => setOpen(false)} postType={postType} noun={noun} canManage={canManage} />
  return { start, dialog, hasTemplates }
}

type Loaded = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; templates: PostTemplate[] }

const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

export default function NewPostDialog({ isOpen, onClose, postType, noun, canManage }: NewPostDialogProps) {
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  // The template being used (a post is being made from it), renamed or deleted.
  const [using, setUsing] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string; error: string | null; saving: boolean } | null>(null)
  const [deleting, setDeleting] = useState<{ template: PostTemplate; busy: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    let live = true
    setLoaded({ state: "loading" })
    setUsing(null)
    setRenaming(null)
    setDeleting(null)
    setError(null)
    listPostTemplates(postType)
      .then((templates) => live && setLoaded({ state: "ready", templates }))
      .catch((e) => live && setLoaded({ state: "error", error: e }))
    return () => {
      live = false
    }
  }, [isOpen, postType])

  if (!isOpen) return null

  const busy = using !== null || !!renaming?.saving || !!deleting?.busy
  const templates = loaded.state === "ready" ? loaded.templates : []
  const replace = (next: PostTemplate[]) => setLoaded({ state: "ready", templates: next })

  const blank = () => {
    onClose()
    navigate(`/content/${postType}/new`)
  }

  const use = async (template: PostTemplate) => {
    setUsing(template.id)
    setError(null)
    try {
      const { post } = await createPostFromTemplate(template.id)
      toast.success(fromTemplateMessage(template.name))
      onClose()
      navigate(`/content/edit/${post.id}`)
    } catch (e) {
      setError(errorMessage(e, `Couldn't start a ${noun} from “${template.name}”.`))
      setUsing(null)
    }
  }

  const saveRename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!renaming) return
    const invalid = templateNameError(renaming.name)
    if (invalid) {
      setRenaming({ ...renaming, error: invalid })
      return
    }
    setRenaming({ ...renaming, error: null, saving: true })
    try {
      const renamed = await renamePostTemplate(renaming.id, renaming.name.trim())
      replace(
        templates
          .map((t) => (t.id === renamed.id ? renamed : t))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id)
      )
      setRenaming(null)
    } catch (err) {
      setRenaming({
        ...renaming,
        saving: false,
        error: templateNameConflict(err, renaming.name, noun) ?? errorMessage(err, "Couldn't rename the template."),
      })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const { template } = deleting
    setDeleting({ template, busy: true })
    setError(null)
    try {
      await deletePostTemplate(template.id)
      replace(templates.filter((t) => t.id !== template.id))
      toast.success(deletedTemplateMessage(template.name))
      setDeleting(null)
    } catch (e) {
      setError(errorMessage(e, `Couldn't delete “${template.name}”.`))
      setDeleting(null)
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => !busy && onClose()}
      title={`New ${noun}`}
      description={`Start blank or from a template: its content, and any category and featured image saved with it.`}
      size="medium"
    >
      <div className="gl-template-chooser">
        {error && (
          <Notice tone="danger" live="alert">
            {error}
          </Notice>
        )}
        <ul className="gl-template-chooser__list" aria-label={`Ways to start a ${noun}`}>
          <li className="gl-template-chooser__item">
            <button type="button" className="gl-template-chooser__option" onClick={blank} disabled={busy}>
              <span className="gl-template-chooser__icon" aria-hidden="true">
                <PencilIcon size={16} />
              </span>
              <span className="gl-template-chooser__text">
                <span className="gl-template-chooser__name">Blank {noun}</span>
                <span className="gl-template-chooser__detail">An empty {noun}</span>
              </span>
              <ChevronRightIcon className="gl-template-chooser__chevron" />
            </button>
          </li>
          {loaded.state === "loading" &&
            [0, 1].map((i) => (
              <li key={i} className="gl-template-chooser__item" aria-hidden="true">
                <span className="gl-template-chooser__option">
                  <Skeleton shape="text" width="50%" />
                </span>
              </li>
            ))}
          {templates.map((template) =>
            renaming?.id === template.id ? (
              <li key={template.id} className="gl-template-chooser__item">
                <form className="gl-template-chooser__rename" onSubmit={saveRename} noValidate>
                  <Input
                    id={`gl-template-rename-${template.id}`}
                    title={`Rename “${template.name}”`}
                    unmasked
                    autoFocus
                    maxLength={TEMPLATE_NAME_MAX}
                    value={renaming.name}
                    error={renaming.error ?? undefined}
                    onChange={(e: any) => setRenaming({ ...renaming, name: inputValue(e) })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation()
                        setRenaming(null)
                      }
                    }}
                  />
                  <div className="gl-template-chooser__actions">
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(null)} disabled={renaming.saving}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" type="submit" loading={renaming.saving}>
                      Save name
                    </Button>
                  </div>
                </form>
              </li>
            ) : deleting?.template.id === template.id ? (
              <li key={template.id} className="gl-template-chooser__item">
                <div className="gl-template-chooser__confirm" role="group" aria-label={`Delete “${template.name}”?`}>
                  <span>
                    Delete <strong>{template.name}</strong>? {noun === "page" ? "Pages" : "Posts"} made from it keep their content.
                  </span>
                  <div className="gl-template-chooser__actions">
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(null)} disabled={deleting.busy} autoFocus>
                      Cancel
                    </Button>
                    <Button variant="danger" size="sm" onClick={confirmDelete} loading={deleting.busy}>
                      Delete template
                    </Button>
                  </div>
                </div>
              </li>
            ) : (
              <li key={template.id} className="gl-template-chooser__item">
                <button type="button" className="gl-template-chooser__option" onClick={() => use(template)} disabled={busy} aria-busy={using === template.id || undefined}>
                  <span className="gl-template-chooser__icon gl-template-chooser__icon--template" aria-hidden="true">
                    <DocumentIcon size={16} />
                  </span>
                  <span className="gl-template-chooser__text">
                    <span className="gl-template-chooser__name">{template.name}</span>
                    <span className="gl-template-chooser__detail">{using === template.id ? `Starting a ${noun}…` : templateSummary(template)}</span>
                  </span>
                  <ChevronRightIcon className="gl-template-chooser__chevron" />
                </button>
                {canManage && (
                  <Menu
                    label={`Manage ${template.name}`}
                    placement="bottom-end"
                    trigger={(props) => (
                      <IconButton {...props} size="sm" aria-label={`Manage “${template.name}”`} icon={<MoreIcon />} disabled={busy} />
                    )}
                  >
                    <MenuItem onSelect={() => setRenaming({ id: template.id, name: template.name, error: null, saving: false })}>Rename</MenuItem>
                    <MenuItem danger onSelect={() => setDeleting({ template, busy: false })}>
                      Delete
                    </MenuItem>
                  </Menu>
                )}
              </li>
            )
          )}
        </ul>
        {loaded.state === "error" && (
          <Notice tone="warning">{errorMessage(loaded.error, "Couldn't load the templates. You can still start a blank one.")}</Notice>
        )}
        {loaded.state === "ready" && templates.length === 0 && (
          <p className="gl-template-chooser__empty">
            No {noun} templates yet.
            {canManage && ` To make one, choose Save as template… in a ${noun}'s menu in the list.`}
          </p>
        )}
      </div>
    </Modal>
  )
}
