import { useCallback, useEffect, useRef, useState } from "react"
import type { PostAuthor } from "@gl-admin/lib/api/types"
import { BylineChangedError, getPostAuthors, searchAuthorCandidates, setPostAuthors } from "@gl-admin/lib/api/posts"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  AUTHORS_HINT,
  MAX_POST_AUTHORS,
  addAuthor,
  authorIds,
  authorName,
  canMoveAuthor,
  canRemoveAuthor,
  candidateOptions,
  moveAuthor,
  removeAuthor,
} from "@gl-admin/lib/postAuthors"
import Avatar from "@gl-admin/components/ui/Avatar"
import Combobox from "@gl-admin/components/ui/Combobox"
import Menu, { MenuItem, MenuSeparator } from "@gl-admin/components/ui/Menu"
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, TrashIcon } from "@gl-admin/components/ui/icons"

interface PostAuthorsProps {
  postId: number
  readOnly: boolean
  // After the byline was saved (the editor re-checks what waits for Update, #358)
  onChange?: () => void
}

const SEARCH_DELAY_MS = 200
const keepAll = () => true

// The byline (#319, "Post editor" on the redesign canvas): who the post credits, in
// order, as chips with an add button. Each change saves the whole byline at once
// (PUT /posts/:id/authors), like the terms beside it. The owner is separate and
// unchanged: being credited gives no access. Read-only users see the chips only.
export default function PostAuthors({ postId, readOnly, onChange }: PostAuthorsProps) {
  const [authors, setAuthors] = useState<PostAuthor[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [candidates, setCandidates] = useState<PostAuthor[]>([])
  const latestQuery = useRef("")
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const restoreFocus = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    getPostAuthors(postId)
      .then((list) => {
        if (!cancelled) setAuthors(list)
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [postId])

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
  }, [])

  const search = useCallback((q: string) => {
    latestQuery.current = q
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      searchAuthorCandidates(q)
        .then((list) => {
          if (latestQuery.current === q) setCandidates(list)
        })
        .catch(() => {
          // Suggestions are optional; the field keeps what it has.
        })
    }, SEARCH_DELAY_MS)
  }, [])

  const startAdding = () => {
    setAdding(true)
    search("")
  }

  // Optimistic: show the new byline at once, put the old one back if saving fails.
  // The save names the byline it changed, so someone else's change made meanwhile
  // isn't overwritten: then their byline is shown instead, to change again.
  const save = async (next: PostAuthor[]) => {
    if (next === authors) return
    const previous = authors
    setAuthors(next)
    setSaving(true)
    setSaveError(null)
    try {
      setAuthors(await setPostAuthors(postId, authorIds(next), authorIds(previous)))
      onChange?.()
    } catch (error) {
      if (error instanceof BylineChangedError) {
        setAuthors(error.current)
        setSaveError(error.message)
      } else {
        setAuthors(previous)
        setSaveError(errorMessage(error))
      }
    } finally {
      setSaving(false)
    }
  }

  // Picking someone closes the picker, which had focus: give it to the add button
  // (or, with a full byline, the last chip) instead of losing it to the page.
  useEffect(() => {
    // Controls are disabled while a save runs; focus once they're back.
    if (adding || saving || !restoreFocus.current) return
    restoreFocus.current = false
    const target =
      listRef.current?.querySelector<HTMLButtonElement>(".post-authors__add") ??
      [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button.post-authors__chip") ?? [])].pop()
    target?.focus()
  }, [adding, saving])

  const closePicker = () => {
    restoreFocus.current = true
    setAdding(false)
  }

  if (loading) return <small className="post-settings__hint">Loading authors…</small>
  if (loadError) return <small className="post-settings__error">{loadError}</small>

  const full = authors.length >= MAX_POST_AUTHORS

  return (
    <div className="post-authors">
      <ul ref={listRef} className="post-authors__list" aria-label="Authors" aria-busy={saving || undefined}>
        {authors.map((author, i) => {
          const name = authorName(author)
          const chip = (
            <>
              <Avatar user={{ id: author.id, name, src: author.avatar }} size={20} decorative />
              <span className="post-authors__name">{name}</span>
            </>
          )
          return (
            <li key={author.id} className="post-authors__item">
              {readOnly ? (
                <span className="post-authors__chip">{chip}</span>
              ) : (
                <Menu
                  label={`${name}: author options`}
                  trigger={(props) => (
                    <button
                      {...props}
                      type="button"
                      className="post-authors__chip post-authors__chip--button"
                      aria-label={`${name}, author ${i + 1} of ${authors.length}`}
                      disabled={saving}
                    >
                      {chip}
                    </button>
                  )}
                >
                  <MenuItem
                    icon={<ChevronLeftIcon />}
                    disabled={!canMoveAuthor(authors, author.id, -1)}
                    onSelect={() => void save(moveAuthor(authors, author.id, -1))}
                  >
                    Move earlier
                  </MenuItem>
                  <MenuItem
                    icon={<ChevronRightIcon />}
                    disabled={!canMoveAuthor(authors, author.id, 1)}
                    onSelect={() => void save(moveAuthor(authors, author.id, 1))}
                  >
                    Move later
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<TrashIcon />}
                    danger
                    disabled={!canRemoveAuthor(authors)}
                    description={canRemoveAuthor(authors) ? undefined : "A post credits at least one author."}
                    onSelect={() => void save(removeAuthor(authors, author.id))}
                  >
                    Remove
                  </MenuItem>
                </Menu>
              )}
            </li>
          )
        })}
        {!readOnly && !adding && !full && (
          <li className="post-authors__item">
            <button type="button" className="post-authors__add" aria-label="Add author" onClick={startAdding} disabled={saving}>
              <PlusIcon />
            </button>
          </li>
        )}
      </ul>
      {adding && !readOnly && (
        <div className="post-authors__picker">
          <Combobox
            label="Add author"
            placeholder="Search people"
            options={candidateOptions(candidates, authors)}
            value={null}
            filter={keepAll}
            onQueryChange={search}
            emptyMessage="No one else to credit"
            disabled={saving}
            onChange={(value) => {
              const picked = candidates.find((c) => String(c.id) === value)
              if (!picked) return
              closePicker()
              void save(addAuthor(authors, picked))
            }}
          />
          <button type="button" className="post-authors__done" onClick={closePicker}>
            Done
          </button>
        </div>
      )}
      {saveError && (
        <small className="post-settings__error" role="alert">
          {saveError}
        </small>
      )}
      <small className="post-settings__hint">{AUTHORS_HINT}</small>
    </div>
  )
}
