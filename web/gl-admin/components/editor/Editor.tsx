import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, useCallback } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { authManager } from "@gl-admin/lib/auth"
import { pmToBlockDoc, setEditorBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { CollabSaveStatus, type SaveState } from "@gl-admin/lib/collaboration/CollabSaveStatus"
import type { CollabAccess, HocuspocusCollaboration } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { restoreVersionLive } from "@gl-admin/lib/collaboration/liveRestore"
import { acquirePostCollab, releasePostCollab } from "@gl-admin/lib/collaboration/postCollab"
import {
  EDITOR_FRAGMENT,
  describeUnbuildableTypes,
  findUnbuildableTypes,
  type UnbuildableTypes,
} from "@gl-admin/lib/collaboration/schemaGuard"
import { useTheme } from "@gl-admin/contexts/ThemeContext"
import { markdownRuleOptions, useEditorSettings } from "@gl-admin/lib/editorSettings"
import { applyLink, openLinkModal } from "./utils/linkManager"
import LinkModal from "./ui/LinkModal"
import BubbleMenu from "./ui/BubbleMenu"
import BlockTypeToolbar from "./ui/BlockTypeToolbar"
import ImageToolbar from "./ui/ImageToolbar"
import EmbedToolbar from "./ui/EmbedToolbar"
import DragHandle from "./ui/DragHandle"
import BlockComments from "./ui/BlockComments"
import type { BlockRef } from "./utils/blockActions"
import type { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import { PostBlockEditsStore } from "@gl-admin/lib/blockEditsStore"
import { BlockEditsContext } from "./blockEditsContext"
import CharacterCount from "./ui/CharacterCount"
import MediaPickerHost from "./ui/MediaPickerHost"
import { getExtensions } from "./utils/extensions"
import { scrollToCollaborator } from "./utils/cursorAwareness"
import { reloadPage } from "./utils/reloadPage"
import { editorSchema } from "./utils/editorSchema"
import Notice from "@gl-admin/components/ui/Notice"
import Modal from "@gl-admin/components/ui/Modal"
import Button from "@gl-admin/components/ui/Button"
import "@gl-admin/assets/styles/components/editor/editor.scss"

// The post editor (#206). It is a bound editor: it never seeds the doc and never saves
// content. The collab server (web/collab-server/) seeds a new doc from block_doc and
// stores every change, debounced (gl-admin/lib/collaboration/CLAUDE.md).
//   - Save status comes from the server's `stored` / `store_failed` messages
//     (CollabSaveStatus), and the "blocks can't be shown" notice from `meta.dropped`.
//   - Anyone who may read the post's blocks gets the live doc. A user who can't edit it
//     (a contributor on someone else's post) gets a live read-only view: the editor is not
//     editable, and the server drops that connection's updates anyway.
//   - Publish doesn't save first: it waits until the server has every local edit, then
//     the API flushes the collab server before snapshotting block_doc.
//   - Restore goes through the editor (rule 9) and waits for the store that includes it.
//   - On `stale-epoch` (the server reseeded the doc), the Y.Doc is dropped and the editor
//     remounts on a fresh one.
//   - Access changes while open (#313): the server re-checks access periodically. A
//     demotion turns the editor view-only with a notice (the doc and what's on screen
//     stay); a revoked session (user deleted, password changed or reset, no access any
//     more) stays on screen read-only with a "sign in again" notice.
//   - Theme extensions are registered before Collaboration binds: the theme gate waits for
//     the theme, and the schema gate (rule 10) checks the synced fragment against the
//     schema the editor will have. Unbuildable types → no binding at all (y-tiptap would
//     delete them for everyone), a static view from REST instead.
//   - A different schema on the server (#416, a deploy since this page loaded): refused at
//     connect with `schema-mismatch`, never retried. "The editor was updated. Reload to keep
//     editing." with a Reload button; nothing is bound (a static view from REST), or, if it
//     was refused on a reconnect, the bound doc stays on screen read-only and gets nothing
//     more from the server.
//   - Markdown shortcuts (#330, a workspace setting) only switch TipTap's input and paste
//     rules (editor options; lib/editorSettings.ts). The editor mounts once they're known;
//     connecting doesn't wait for them.

export type EditorProps = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
  postId?: number
  title?: string
  enableCollaboration?: boolean
  // Save / publish callbacks (save status comes from the collab server)
  onSaveStart?: () => void
  onSaveSuccess?: (revision: number) => void
  onSaveError?: (error: Error) => void
  onPublishStart?: () => void
  onPublishSuccess?: (result: { versionId: number; versionNo: number; cancelledScheduledUpdate: boolean }) => void
  onPublishError?: (error: Error) => void
  /**
   * The collab server changed this session's access while open (#313). The form re-reads
   * the user's role then, so the rest of it (title, settings, publish) follows the body.
   */
  onAccessChange?: (access: CollabAccess) => void
  /**
   * The collab server stored a changed working copy, from anyone's edits (`stored` with
   * `block_doc: "written"`). The form re-reads "Changes not published" then (#326).
   * Read-only: it only listens to the messages CollabSaveStatus already gets.
   */
  onStored?: () => void
  /** The post's public URL, for the block menu's "Copy link to block" (#356). */
  postUrl?: string | null
  /**
   * The post's block comments (#192): markers on blocks, the hover "Comment" button, the
   * block menu's Comment and Ctrl M. The editor refetches them on the collab server's
   * "comments" nudge and on every reconnect, and reports its block ids. Live editors only.
   */
  comments?: PostCommentsStore | null
  /**
   * The editable TipTap editor once it's mounted, null while there is none (read-only,
   * remounting, gone). The settings panel's Block tab (#417) reads the selected block from
   * it and changes its settings with ordinary transactions.
   */
  onEditorReady?: (editor: TiptapEditor | null) => void
  /** ⌘⇧, (#417, "Toolbar and settings"): open or close the settings panel on its Block tab. */
  onToggleBlockSettings?: () => void
}

export interface EditorRef {
  forceSave: () => Promise<void>
  publish: () => Promise<{ versionId: number; versionNo: number; cancelledScheduledUpdate: boolean } | undefined>
  // Resolves once the collab server has every edit typed here (publish's first step).
  // Scheduling an update (#335) waits for it too: the API then flushes the server and
  // freezes block_doc, so the snapshot has those edits.
  whenAcknowledged: () => Promise<void>
  // Load a stored version into the working copy through the editor (#136)
  restoreVersion: (doc: BlockDocV1) => Promise<{ saved: boolean }>
  /**
   * A new post's body (no collab doc yet) as Block Spec, for `POST /posts`: the collab
   * server's own bridge (pmToBlockDoc), so marks, attrs and theme blocks reach the seed as
   * the store would write them. Null when the body is empty or the post exists (its body
   * is the server's, rule 11).
   */
  getBlockDoc: () => BlockDocV1 | null
  getSaveStatus: () => { isSaving: boolean; isPublishing: boolean; saveStatus: "saved" | "saving" | "error" | null }
  /**
   * Presence "jump to cursor" (#356): scrolls to the caret of the first of these awareness
   * clients (one person's tabs) that has one in the text. False when none has (they're
   * elsewhere, or their window lost focus, which clears a caret).
   */
  jumpToCollaborator: (clientIds: number[]) => boolean
}

type InnerProps = EditorProps & {
  collab: HocuspocusCollaboration | null
  unbuildable?: UnbuildableTypes
  /** Focus the end of the doc on mount (not on a remount for an access change: the user is elsewhere). */
  autoFocus?: boolean
  /** The workspace's Markdown shortcuts setting, read when the editor is created. */
  markdownShortcuts?: boolean
}

const EditorInner = forwardRef<EditorRef, InnerProps>(function EditorInner(
  {
    value,
    onChange,
    // An empty post's hint; the default is the design's (EMPTY_POST_HINT, #415).
    placeholder,
    readOnly = false,
    minChars,
    maxChars,
    postId,
    onSaveStart,
    onSaveSuccess,
    onSaveError,
    onPublishStart,
    onPublishSuccess,
    onPublishError,
    onStored,
    postUrl,
    comments,
    onEditorReady,
    onToggleBlockSettings,
    collab,
    unbuildable,
    autoFocus = true,
    markdownShortcuts = true,
  },
  ref
) {
  const [isPublishing, setIsPublishing] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>(null)
  const [droppedCount, setDroppedCount] = useState(0)
  // The count the user dismissed: a different count (a restore) shows the notice again.
  const [droppedDismissed, setDroppedDismissed] = useState(0)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [url, setUrl] = useState("")

  // Kept current in refs: the save-status subscription lives as long as the connection.
  const callbacks = useRef({ onSaveStart, onSaveSuccess, onSaveError, onStored })
  callbacks.current = { onSaveStart, onSaveSuccess, onSaveError, onStored }

  // Created by the effect that destroys it, not in useMemo: StrictMode runs effects
  // mount → cleanup → mount, and a memoized instance would be destroyed by the first cleanup
  // and then used dead (no doc listener, no subscribers).
  const [saveStatus, setSaveStatusTracker] = useState<CollabSaveStatus | null>(null)
  useEffect(() => {
    if (!collab) return
    const status = new CollabSaveStatus(collab)
    setSaveStatusTracker(status)
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const off = status.subscribe(({ state, error, revision }) => {
      clearTimeout(clearTimer)
      setSaveState(state)
      if (state === "saving") callbacks.current.onSaveStart?.()
      if (state === "saved") {
        callbacks.current.onSaveSuccess?.(revision ?? 0)
        clearTimer = setTimeout(() => setSaveState(null), 3000)
      }
      if (state === "error") {
        console.error("Save failed:", error)
        callbacks.current.onSaveError?.(error ?? new Error("Save failed"))
      }
    })
    const offDropped = status.watchDroppedBlocks((entries) => setDroppedCount(entries.length))
    const offStored = collab.onStore((message) => {
      if (message.type === "stored" && message.block_doc === "written") callbacks.current.onStored?.()
    })
    return () => {
      clearTimeout(clearTimer)
      off()
      offDropped()
      offStored()
      status.destroy()
      setSaveStatusTracker(null)
    }
  }, [collab])

  const extensions = useMemo(
    () => getExtensions({ collabProvider: collab, maxChars, placeholder, setUrl, setIsLinkModalOpen })(),
    [collab, maxChars, placeholder]
  )

  const editor = useEditor(
    {
      editable: !readOnly,
      // TipTap's injected base CSS is removed by any destroyed editor (shared tag); it
      // ships in editor.scss instead (_tiptap-base.scss, #305).
      injectCSS: false,
      extensions,
      // Read at creation only (not a dependency): a changed setting never recreates a
      // bound editor; it applies to the next one.
      ...markdownRuleOptions(markdownShortcuts),
      // Bound to the collab doc: content comes from the server, never from here.
      content: !collab ? value || "<p></p>" : undefined,
      autofocus: false,
      onUpdate({ editor }) {
        const html = editor.getHTML()
        const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
        queueMicrotask(() => onChange(html, text))
      },
      editorProps: { attributes: { class: "gl-content-editor notion-editor-content" } },
    },
    [extensions, readOnly, collab]
  )

  useEffect(() => {
    if (!editor || readOnly || !autoFocus) return
    const raf = requestAnimationFrame(() => {
      try {
        editor.commands.focus("end")
      } catch {
        // destroyed before focus
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [editor, readOnly, autoFocus])

  // No collab doc (create mode): the form's value is the content.
  useEffect(() => {
    if (!editor || collab) return
    if (value !== editor.getHTML() && !readOnly) {
      editor.commands.setContent(value || "<p></p>", { emitUpdate: false })
    }
  }, [value, editor, collab, readOnly])

  // Not bound because the doc has types this editor can't build: show the REST working
  // copy (GET /posts/:id/blocks). No Yjs involved.
  const staticLoadedRef = useRef<{ editor: typeof editor; postId: number } | null>(null)
  useEffect(() => {
    if (!editor || !readOnly || !postId || collab) return
    const loaded = () => staticLoadedRef.current?.editor === editor && staticLoadedRef.current?.postId === postId
    if (loaded()) return
    let cancelled = false
    let inFlight = false
    const load = async () => {
      if (cancelled || inFlight || loaded()) return
      inFlight = true
      try {
        const token = authManager.getAccessToken()
        if (token) blockAPIClient.setAuthToken(token)
        const { doc } = await blockAPIClient.getPostBlocks(postId)
        if (cancelled || editor.isDestroyed) return
        if (doc.blocks_order.length > 0) setEditorBlockDoc(editor, doc)
        staticLoadedRef.current = { editor, postId }
      } catch (error) {
        console.error("[Editor] Failed to load read-only content:", error)
      } finally {
        inFlight = false
      }
    }
    load()
    const unsubscribe = authManager.subscribe((state) => {
      if (state.accessToken) load()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [editor, readOnly, postId, collab])

  const blockedError = () =>
    new Error(`Editing is disabled: this post has blocks the editor can't load (${describeUnbuildableTypes(unbuildable!)})`)

  useImperativeHandle(
    ref,
    () => ({
      // Content saves itself on the server; "Save" waits until it has.
      forceSave: async () => {
        if (unbuildable) throw blockedError()
        if (readOnly || !saveStatus) return
        await saveStatus.settled()
      },
      publish: async () => {
        if (unbuildable) throw blockedError()
        if (!postId || isPublishing || readOnly) return undefined
        setIsPublishing(true)
        onPublishStart?.()
        try {
          // The API flushes the collab server before reading block_doc; make sure the
          // server has every edit typed here first.
          await saveStatus?.whenAcknowledged()
          const token = authManager.getAccessToken()
          if (token) blockAPIClient.setAuthToken(token)
          const result = await blockAPIClient.publishPost(postId)
          onPublishSuccess?.(result)
          return result
        } catch (error) {
          console.error("Publish failed:", error)
          onPublishError?.(error as Error)
          throw error
        } finally {
          setIsPublishing(false)
        }
      },
      whenAcknowledged: async () => {
        if (unbuildable) throw blockedError()
        if (readOnly) return
        await saveStatus?.whenAcknowledged()
      },
      restoreVersion: async (doc) => {
        if (unbuildable) throw blockedError()
        if (!collab || !saveStatus || !editor || readOnly) throw new Error("Restoring needs the collaborative editor")
        const { saved } = await restoreVersionLive(editor, doc, collab.doc, saveStatus)
        return { saved }
      },
      getBlockDoc: () => {
        // An existing post's body (bound, or the static view) is the server's.
        if (collab || postId || !editor || editor.isDestroyed || editor.isEmpty) return null
        return pmToBlockDoc(editor.state.doc)
      },
      getSaveStatus: () => ({ isSaving: saveState === "saving", isPublishing, saveStatus: saveState }),
      jumpToCollaborator: (clientIds) =>
        editor && !editor.isDestroyed && collab ? scrollToCollaborator(editor.view, collab.provider.awareness, clientIds) : false,
    }),
    [collab, saveStatus, editor, postId, readOnly, isPublishing, saveState, onPublishStart, onPublishSuccess, onPublishError, unbuildable]
  )

  const applyLinkWithModal = useCallback(() => {
    if (!editor) return
    applyLink(editor, url, setIsLinkModalOpen)
  }, [editor, url])

  const openLinkModalWithEditor = useCallback(() => {
    if (!editor) return
    openLinkModal(editor, setUrl, setIsLinkModalOpen)
  }, [editor])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) return
      if (!editor || readOnly) return
      const selection = editor.state.selection
      if (selection.empty || selection.from === selection.to) return
      e.preventDefault()
      openLinkModalWithEditor()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [editor, readOnly, openLinkModalWithEditor])

  // Block comments (#192): refetch on the server's nudge, after every (re)sync (a nudge may
  // have been missed while disconnected) and on an access change; the blocks the editor
  // can't show (#213).
  useEffect(() => {
    if (!collab || !comments) return
    const offNudge = collab.onComments(() => void comments.refresh())
    const offSynced = collab.onSynced(() => void comments.refresh())
    // What the caller may do with comments follows their access (a #321 grant, a demotion).
    const offAccess = collab.onAccess(() => void comments.refresh())
    return () => {
      offNudge()
      offSynced()
      offAccess()
    }
  }, [collab, comments])
  useEffect(() => {
    if (!saveStatus || !comments) return
    return saveStatus.watchDroppedBlocks((entries) => comments.setHiddenIds(entries.map((entry) => entry.id)))
  }, [saveStatus, comments])
  // Ctrl M: comment on the block holding the cursor (blockActions.ts).
  useEffect(() => {
    if (!editor || !comments || !collab) return
    const storage = (editor.storage as unknown as Record<string, { openComment: ((ref: BlockRef) => void) | null }>).blockActions
    if (!storage) return
    storage.openComment = (ref) => {
      if (ref.id) comments.focusBlock(ref.id, true)
    }
    return () => {
      if (storage.openComment) storage.openComment = null
    }
  }, [editor, comments, collab])
  // The settings panel's Block tab (#417) reads the editable editor; ⌘⇧, opens it.
  const panel = useRef({ onEditorReady, onToggleBlockSettings })
  panel.current = { onEditorReady, onToggleBlockSettings }
  useEffect(() => {
    if (!editor || readOnly) return
    panel.current.onEditorReady?.(editor)
    const storage = (editor.storage as unknown as Record<string, { toggleBlockSettings: (() => void) | null }>).blockNavigationKeys
    if (storage) storage.toggleBlockSettings = () => panel.current.onToggleBlockSettings?.()
    return () => {
      if (storage) storage.toggleBlockSettings = null
      panel.current.onEditorReady?.(null)
    }
  }, [editor, readOnly])
  const onComment = useCallback((ref: BlockRef) => {
    if (ref.id) comments?.focusBlock(ref.id, true)
  }, [comments])
  const commentsLive = !!comments && !!collab

  // Per-block "Last edited by" (#328) for the block menu: read when bound and after every
  // reconnect, then kept current from the server's `stored` messages (their `edits`).
  // Created by the effect that destroys it (StrictMode; see saveStatus above).
  const [blockEdits, setBlockEdits] = useState<PostBlockEditsStore | null>(null)
  useEffect(() => {
    if (!collab || !postId || readOnly) return
    const store = new PostBlockEditsStore(postId)
    setBlockEdits(store)
    const offSynced = collab.onSynced(() => void store.refresh())
    const offStored = collab.onStore((message) => {
      if (message.type === "stored" && message.block_doc === "written") store.applyStored(message.edits)
    })
    void store.refresh()
    return () => {
      offSynced()
      offStored()
      store.destroy()
      setBlockEdits(null)
    }
  }, [collab, postId, readOnly])

  if (!editor) return null

  return (
    <div className="notion-editor">
      {droppedCount > 0 && droppedCount !== droppedDismissed && (
        <Notice
          tone="warning"
          live="status"
          className="editor-notice"
          title={`${droppedCount} block${droppedCount === 1 ? "" : "s"} can't be shown here`}
          onDismiss={() => setDroppedDismissed(droppedCount)}
        >
          The editor doesn't support {droppedCount === 1 ? "it" : "them"} yet. {droppedCount === 1 ? "It's" : "They're"}{" "}
          kept in the post, where {droppedCount === 1 ? "it was" : "they were"}.
        </Notice>
      )}
      {!readOnly && <BubbleMenu editor={editor} openLinkModal={openLinkModalWithEditor} />}
      {!readOnly && <BlockTypeToolbar editor={editor} />}
      {!readOnly && <ImageToolbar editor={editor} />}
      {!readOnly && <EmbedToolbar editor={editor} />}
      {!readOnly && (
        <BlockEditsContext.Provider value={blockEdits}>
          <DragHandle editor={editor} postUrl={postUrl} onComment={commentsLive ? onComment : undefined} />
        </BlockEditsContext.Provider>
      )}
      {!readOnly && <MediaPickerHost editor={editor} postId={postId} />}

      <div className="editor-wrapper">
        {commentsLive && comments ? (
          <BlockComments editor={editor} store={comments}>
            <EditorContent editor={editor} />
          </BlockComments>
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>

      {isLinkModalOpen && (
        <LinkModal
          editor={editor}
          setIsLinkModalOpen={setIsLinkModalOpen}
          applyLink={applyLinkWithModal}
          url={url}
          setUrl={setUrl}
        />
      )}
      <CharacterCount editor={editor} minChars={minChars} maxChars={maxChars} />
    </div>
  )
})

// Opening the post: the content's shape, until it's connected ("Editor connection
// states" 1). The text is for screen readers.
function Placeholder({ text }: { text: string }) {
  return (
    <div className="notion-editor">
      <div className="editor-wrapper editor-loading" aria-busy="true">
        <span className="editor-loading__label">{text}</span>
        {[96, 90, 60, 0, 40, 94, 82].map((width, i) =>
          width === 0 ? null : (
            <span key={i} aria-hidden="true" className={`editor-loading__line${i === 4 ? " editor-loading__line--heading" : ""}`} style={{ width: `${width}%` }} />
          )
        )}
      </div>
    </div>
  )
}

type Gate = { collab: HocuspocusCollaboration; unbuildable: UnbuildableTypes | null }

const signInAgain = () => void authManager.logout("session-expired")

const OUTDATED_EDITOR_MESSAGE = "The editor was updated. Reload to keep editing."

// The collab server runs a different editor schema (#416): only a reload brings it.
function OutdatedNotice() {
  return (
    <Notice
      tone="warning"
      live="alert"
      inline
      className="editor-notice editor-notice--banner editor-notice--outdated"
      actions={
        <Button variant="primary" size="sm" onClick={() => reloadPage()}>
          Reload
        </Button>
      }
    >
      {OUTDATED_EDITOR_MESSAGE}
    </Notice>
  )
}

// What the server's access re-check changed while the editor was open (#313).
function AccessNotice({ access }: { access: CollabAccess }) {
  // Dismissed per change: the next access message is a new object.
  const [dismissed, setDismissed] = useState<CollabAccess | null>(null)
  if (access.outdated) return <OutdatedNotice />

  // The post went to the trash (#327): the session is fine, the post isn't editable.
  if (access.trashed) {
    return (
      <Notice tone="warning" live="alert" inline className="editor-notice" title="This post was moved to the trash">
        It's shown read-only, and changes made after that weren't saved. Restore it from the Trash tab of the posts list
        to edit it again.
      </Notice>
    )
  }
  if (access.revoked) {
    const email = authManager.getState().user?.email
    return (
      <>
        <Modal
          isOpen={dismissed !== access}
          onClose={() => setDismissed(access)}
          role="alertdialog"
          size="small"
          title="Your session ended"
          description="Sign in again to keep editing."
          showCloseButton={false}
          closeOnBackdrop={false}
          footer={
            <Button variant="primary" size="lg" onClick={signInAgain}>
              Sign in again
            </Button>
          }
        >
          <p className="editor-session-ended__why">
            Your access to this post changed, or your password was changed or reset. Changes made after that weren't saved.
          </p>
          {email && <p className="editor-session-ended__account">{email}</p>}
        </Modal>
        {dismissed === access && (
          <Notice
            tone="danger"
            live="alert"
            inline
            className="editor-notice"
            title="Your session ended"
            actions={
              <Button variant="secondary" size="sm" onClick={signInAgain}>
                Sign in again
              </Button>
            }
          >
            The post is shown read-only. Changes made after that weren't saved.
          </Notice>
        )}
      </>
    )
  }
  if (access.reason === "demoted" && dismissed !== access) {
    return (
      <Notice
        tone="info"
        live="status"
        inline
        className="editor-notice editor-notice--banner"
        title="Your access changed to view-only"
        actions={
          <Button variant="secondary" size="sm" onClick={() => setDismissed(access)}>
            OK
          </Button>
        }
      >
        Your access to this post changed while it was open. You still see live changes from others; anything you typed
        after the change wasn't saved.
      </Notice>
    )
  }
  if (access.reason === "unverified") {
    return (
      <Notice tone="warning" live="status" className="editor-notice editor-notice--banner" title="Editing is paused">
        The server can't confirm your access right now. Editing resumes on its own once it can.
      </Notice>
    )
  }
  return null
}

// Connects (after the theme gate), waits for the first sync, checks the fragment against
// the schema the editor will get (rule 10), then mounts the bound editor. A stale-epoch
// refusal (the server reseeded) bumps `generation`: release the dead connection and start
// over on a fresh Y.Doc.
const LiveGate = forwardRef<EditorRef, EditorProps>(function LiveGate(props, ref) {
  const { postId, enableCollaboration = true, readOnly = false } = props
  const live = !!postId && enableCollaboration
  const [generation, setGeneration] = useState(0)
  const [gate, setGate] = useState<Gate | null>(null)
  const [access, setAccess] = useState<CollabAccess | null>(null)
  const onAccessChange = useRef(props.onAccessChange)
  onAccessChange.current = props.onAccessChange
  // Loaded alongside the connection; only mounting the editor waits for it.
  const editorSettings = useEditorSettings()

  useEffect(() => {
    if (!live || !postId) return
    const collab = acquirePostCollab(postId)
    let cancelled = false
    const offStale = collab.onStale(() => {
      if (cancelled) return
      setGate(null)
      setGeneration((g) => g + 1)
    })
    const offAccess = collab.onAccess((next) => {
      if (cancelled) return
      setAccess(next)
      onAccessChange.current?.(next)
    })
    collab.whenSynced().then(() => {
      if (cancelled || collab.stale) return
      // The schema the editor computes (theme ones from the registry, registered by now),
      // the same one its schema fingerprint describes (#416).
      const schema = editorSchema()
      const unbuildable = findUnbuildableTypes(collab.doc.getXmlFragment(EDITOR_FRAGMENT), schema)
      if (unbuildable) {
        console.error(
          `[Editor] Not binding collaboration: the shared doc has types this editor can't build (${describeUnbuildableTypes(unbuildable)}). Opening read-only.`
        )
      }
      setAccess(collab.getAccess())
      setGate({ collab, unbuildable })
    })
    return () => {
      cancelled = true
      offStale()
      offAccess()
      setGate(null)
      setAccess(null)
      releasePostCollab(collab)
    }
  }, [live, postId, generation])

  if (!editorSettings) return <Placeholder text={live ? "Connecting…" : "Loading…"} />
  const { markdownShortcuts } = editorSettings
  if (!live) return <EditorInner ref={ref} {...props} collab={null} markdownShortcuts={markdownShortcuts} />
  // Refused at connect because the post is in the trash (#327): it never syncs, so say why
  // instead of "Connecting…" forever.
  if (!gate && access?.trashed) return <AccessNotice access={access} />
  // Refused at connect because the server's schema isn't this editor's (#416): bind
  // nothing, show the stored working copy read-only (REST) under the reload notice.
  if (!gate && access?.outdated) {
    return (
      <>
        <AccessNotice access={access} />
        <EditorInner ref={ref} {...props} readOnly collab={null} markdownShortcuts={markdownShortcuts} />
      </>
    )
  }
  if (!gate || gate.collab.postId !== postId || gate.collab.stale) return <Placeholder text="Connecting…" />
  if (!gate.unbuildable) {
    const viewOnly = readOnly || (access?.readOnly ?? gate.collab.readOnly)
    return (
      <>
        {access && <AccessNotice access={access} />}
        {/* Remounted (not re-rendered) when the server changes the mode (#313): the
            editing UI (DragHandle's element is moved into the editor DOM by its plugin)
            can't be unmounted on its own while the editor is recreated; React's
            removeChild then throws and the page crashes. The doc lives in the Y.Doc. */}
        <EditorInner
          key={`${generation}:${viewOnly ? "view" : "edit"}`}
          ref={ref}
          {...props}
          collab={gate.collab}
          readOnly={viewOnly}
          autoFocus={!access?.reason}
          markdownShortcuts={markdownShortcuts}
        />
      </>
    )
  }
  return (
    <>
      <Notice tone="warning" live="alert" className="editor-notice editor-notice--banner" title="This post is open read-only">
        It contains {describeUnbuildableTypes(gate.unbuildable)} that the editor can't load, usually because the theme
        that provides them failed to load or is no longer active. Editing here would delete them for everyone, so editing
        is off until that theme is available. Those blocks are hidden below but kept in the post.
      </Notice>
      {(access?.revoked || access?.outdated) && <AccessNotice access={access} />}
      <EditorInner ref={ref} {...props} readOnly collab={null} unbuildable={gate.unbuildable} markdownShortcuts={markdownShortcuts} />
    </>
  )
})

export default forwardRef<EditorRef, EditorProps>(function Editor(props, ref) {
  const { isThemeLoaded } = useTheme()
  // Theme first: its node types must be registered before Collaboration binds.
  if (!isThemeLoaded) return <Placeholder text="Loading theme…" />
  return <LiveGate ref={ref} {...props} />
})
