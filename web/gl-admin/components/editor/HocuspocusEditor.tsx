import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, useCallback } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { getSchema } from "@tiptap/core"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"
import { authManager } from "@gl-admin/lib/auth"
import { setEditorBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { CollabSaveStatus, type SaveState } from "@gl-admin/lib/collaboration/CollabSaveStatus"
import type { HocuspocusCollaboration } from "@gl-admin/lib/collaboration/HocuspocusCollaboration"
import { restoreVersionLive } from "@gl-admin/lib/collaboration/liveRestore"
import { acquirePostCollab, releasePostCollab } from "@gl-admin/lib/collaboration/postCollab"
import {
  EDITOR_FRAGMENT,
  describeUnbuildableTypes,
  findUnbuildableTypes,
  type UnbuildableTypes,
} from "@gl-admin/lib/collaboration/schemaGuard"
import { useTheme } from "@gl-admin/contexts/ThemeContext"
import { applyLink, openLinkModal } from "./utils/linkManager"
import LinkModal from "./ui/LinkModal"
import BubbleMenu from "./ui/BubbleMenu"
import BlockTypeToolbar from "./ui/BlockTypeToolbar"
import DragHandle from "./ui/DragHandle"
import CharacterCount from "./ui/CharacterCount"
import MediaSelector from "./ui/MediaSelector"
import { getExtensions } from "./utils/extensions"
import type { EditorProps, EditorRef } from "./Editor"
import "@gl-admin/assets/styles/components/editor/editor.scss"

// The editor on the Hocuspocus path (PUBLIC_COLLAB_BACKEND=hocuspocus, #206 P3, #283).
// Editor.tsx renders this instead of its own y-websocket editor when the build sets the
// flag; the y-websocket path there is unchanged. P5 deletes that path.
//
// Differences from the y-websocket editor (collaboration/CLAUDE.md):
//   - It never seeds the doc and never saves content: no onSynced seed, no
//     hasInitializedRef, no notifyEditorChange autosave, no BlockDocManager mirror. The
//     server seeds a new doc from block_doc and stores every change (debounced).
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
//   - Theme extensions are registered before Collaboration binds: the theme gate waits for
//     the theme, and the schema gate (rule 10) checks the synced fragment against the
//     schema the editor will have. Unbuildable types → no binding at all (y-tiptap would
//     delete them for everyone), a static view from REST instead.

type InnerProps = EditorProps & {
  collab: HocuspocusCollaboration | null
  unbuildable?: UnbuildableTypes
}

const HocuspocusEditorInner = forwardRef<EditorRef, InnerProps>(function HocuspocusEditorInner(
  {
    value,
    onChange,
    placeholder = "Type '/' for commands...",
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
    collab,
    unbuildable,
  },
  ref
) {
  const [isPublishing, setIsPublishing] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>(null)
  const [droppedCount, setDroppedCount] = useState(0)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [url, setUrl] = useState("")

  // Kept current in refs: the save-status subscription lives as long as the connection.
  const callbacks = useRef({ onSaveStart, onSaveSuccess, onSaveError })
  callbacks.current = { onSaveStart, onSaveSuccess, onSaveError }

  const saveStatus = useMemo(() => (collab ? new CollabSaveStatus(collab) : null), [collab])
  useEffect(() => {
    if (!saveStatus) return
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const off = saveStatus.subscribe(({ state, error }) => {
      clearTimeout(clearTimer)
      setSaveState(state)
      if (state === "saving") callbacks.current.onSaveStart?.()
      if (state === "saved") {
        callbacks.current.onSaveSuccess?.(0)
        clearTimer = setTimeout(() => setSaveState(null), 3000)
      }
      if (state === "error") {
        console.error("Save failed:", error)
        callbacks.current.onSaveError?.(error ?? new Error("Save failed"))
      }
    })
    const offDropped = saveStatus.watchDroppedBlocks((entries) => setDroppedCount(entries.length))
    return () => {
      clearTimeout(clearTimer)
      off()
      offDropped()
      saveStatus.destroy()
    }
  }, [saveStatus])

  const extensions = useMemo(
    () => getExtensions({ collabProvider: collab, maxChars, placeholder, setUrl, setIsLinkModalOpen })(),
    [collab, maxChars, placeholder]
  )

  const editor = useEditor(
    {
      editable: !readOnly,
      extensions,
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
    if (!editor || readOnly) return
    const raf = requestAnimationFrame(() => {
      try {
        editor.commands.focus("end")
      } catch {
        // destroyed before focus
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [editor, readOnly])

  // No collab doc (create mode): the form's value is the content.
  useEffect(() => {
    if (!editor || collab) return
    if (value !== editor.getHTML() && !readOnly) {
      editor.commands.setContent(value || "<p></p>", { emitUpdate: false })
    }
  }, [value, editor, collab, readOnly])

  // Not bound because the doc has types this editor can't build: show the REST working
  // copy (GET /blocks stays under Hocuspocus). No Yjs involved.
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
      restoreVersion: async (doc) => {
        if (unbuildable) throw blockedError()
        if (!collab || !saveStatus || !editor || readOnly) throw new Error("Restoring needs the collaborative editor")
        const { saved } = await restoreVersionLive(editor, doc, collab.doc, saveStatus)
        return { saved }
      },
      getSaveStatus: () => ({ isSaving: saveState === "saving", isPublishing, saveStatus: saveState }),
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

  if (!editor) return null

  return (
    <div className="notion-editor">
      {droppedCount > 0 && (
        <div className="editor-blocked-notice" role="status">
          {droppedCount} block{droppedCount === 1 ? "" : "s"} of this post can't be shown in the editor. They are
          kept in the saved document.
        </div>
      )}
      {!readOnly && <BubbleMenu editor={editor} openLinkModal={openLinkModalWithEditor} />}
      {!readOnly && <BlockTypeToolbar editor={editor} />}
      {!readOnly && <DragHandle editor={editor} />}
      {!readOnly && <MediaSelector editor={editor} postId={postId} />}

      <div className="editor-wrapper">
        <EditorContent editor={editor} />
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

function Placeholder({ text }: { text: string }) {
  return (
    <div className="notion-editor">
      <div
        className="editor-wrapper"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "200px" }}
      >
        <p style={{ color: "#999" }}>{text}</p>
      </div>
    </div>
  )
}

type Gate = { collab: HocuspocusCollaboration; unbuildable: UnbuildableTypes | null }

// Connects (after the theme gate), waits for the first sync, checks the fragment against
// the schema the editor will get (rule 10), then mounts the bound editor. A stale-epoch
// refusal (the server reseeded) bumps `generation`: release the dead connection and start
// over on a fresh Y.Doc.
const LiveGate = forwardRef<EditorRef, EditorProps>(function LiveGate(props, ref) {
  const { postId, enableCollaboration = true, readOnly = false } = props
  const live = !!postId && enableCollaboration
  const [generation, setGeneration] = useState(0)
  const [gate, setGate] = useState<Gate | null>(null)

  useEffect(() => {
    if (!live || !postId) return
    const collab = acquirePostCollab(postId)
    let cancelled = false
    const offStale = collab.onStale(() => {
      if (cancelled) return
      setGate(null)
      setGeneration((g) => g + 1)
    })
    collab.whenSynced().then(() => {
      if (cancelled || collab.stale) return
      // The extensions the editor computes (theme ones from the registry, registered by
      // now); Collaboration adds no node or mark types.
      const schema = getSchema(getExtensions({ collabProvider: null })())
      const unbuildable = findUnbuildableTypes(collab.doc.getXmlFragment(EDITOR_FRAGMENT), schema)
      if (unbuildable) {
        console.error(
          `[Editor] Not binding collaboration: the shared doc has types this editor can't build (${describeUnbuildableTypes(unbuildable)}). Opening read-only.`
        )
      }
      setGate({ collab, unbuildable })
    })
    return () => {
      cancelled = true
      offStale()
      setGate(null)
      releasePostCollab(collab)
    }
  }, [live, postId, generation])

  if (!live) return <HocuspocusEditorInner ref={ref} {...props} collab={null} />
  if (!gate || gate.collab.postId !== postId || gate.collab.stale) return <Placeholder text="Connecting…" />
  if (!gate.unbuildable) {
    return (
      <HocuspocusEditorInner
        key={generation}
        ref={ref}
        {...props}
        collab={gate.collab}
        readOnly={readOnly || gate.collab.readOnly}
      />
    )
  }
  return (
    <>
      <div className="editor-blocked-notice" role="alert">
        <strong>This post is open read-only.</strong> It contains {describeUnbuildableTypes(gate.unbuildable)} that the
        editor can't load, usually because the theme that provides them failed to load or is no longer active. Editing
        here would delete them for everyone, so editing is disabled until that theme is available. Those blocks are
        hidden below but kept in the post.
      </div>
      <HocuspocusEditorInner ref={ref} {...props} readOnly collab={null} unbuildable={gate.unbuildable} />
    </>
  )
})

export default forwardRef<EditorRef, EditorProps>(function HocuspocusEditor(props, ref) {
  const { isThemeLoaded } = useTheme()
  // Theme first: its node types must be registered before Collaboration binds.
  if (!isThemeLoaded) return <Placeholder text="Loading theme…" />
  return <LiveGate ref={ref} {...props} />
})
