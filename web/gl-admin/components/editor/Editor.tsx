import { useEffect, useState, useCallback, useMemo } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import { applyLink, openLinkModal } from "./utils/linkManager"
import LinkModal from "./ui/LinkModal"
import BubbleMenu from "./ui/BubbleMenu"
import DragHandle from "./ui/DragHandle"
import CharacterCount from "./ui/CharacterCount"
import MediaSelector from "./ui/MediaSelector"
import { getExtensions } from "./utils/extensions"
import "@gl-admin/assets/styles/components/editor/editor.scss"

type Props = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
  postId?: number
  enableCollaboration?: boolean
}

export default function Editor({
  value,
  onChange,
  placeholder = "Type '/' for commands...",
  readOnly = false,
  minChars,
  maxChars,
  postId,
  enableCollaboration = true,
}: Props) {
  // Link modal
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
  const [url, setUrl] = useState('');

  // Collaboration provider
  const collabProvider = useMemo(() => {
    if (postId && enableCollaboration && !readOnly) {
      return CollaborationProvider.getInstance(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly])

  // Editor extensions
  const extensions = useMemo(
    getExtensions({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen }),
    [collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen]
  )

  // Initialize Editor
  const editor = useEditor({
    editable: !readOnly,
    extensions,
    content: !collabProvider ? value || "<p></p>" : undefined,
    autofocus: "end",
    onUpdate({ editor }) {
      const html = editor.getHTML()
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
      onChange(html, text)
    },
    editorProps: {
      attributes: {
        class: "gl-content-editor notion-editor-content",
      },
    },
  })

  // Apply link function
  const applyLinkWithModal = useCallback(() => {
    if (!editor) return;
    applyLink(editor, url, setIsLinkModalOpen);
  }, [editor, url]);

  // Open link modal function
  const openLinkModalWithEditor = useCallback(() => {
    if (!editor) return;
    openLinkModal(editor, setUrl, setIsLinkModalOpen);
  }, [editor]);

  // Keyboard shortcut for opening link modal
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) return;
      if (!editor) return;

      const selection = editor.state.selection;
      if (selection.empty || selection.from === selection.to) return;

      e.preventDefault();
      openLinkModalWithEditor();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, openLinkModalWithEditor]);

  // Collaboration content sync
  useEffect(() => {
    if (!editor || !collabProvider) return
    const onSynced = (isSynced: boolean) => {
      if (!isSynced) return
      const frag = collabProvider.doc.getXmlFragment("prosemirror")
      const emptyShared = frag.length === 0
      const emptyLocal = editor.isEmpty
      if (isSynced && emptyShared && emptyLocal && value && value !== "<p></p>") {
        editor.commands.setContent(value, { emitUpdate: false })
      }
      collabProvider.provider.off("synced", onSynced)
    }
    collabProvider.provider.on("synced", onSynced)
    return () => collabProvider.provider.off("synced", onSynced)
  }, [editor, collabProvider, value])

  // External content changes (e.g. loading existing post)
  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()

    if (value !== current && !collabProvider) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor, collabProvider])

  // Cleanup collaboration provider on unmount
  useEffect(() => {
    if (!postId || !collabProvider) return
    return () => {
      CollaborationProvider.release(postId)
    }
  }, [postId, collabProvider])

  if (!editor) return null

  return (
    <div className="notion-editor">
      <BubbleMenu editor={editor} openLinkModal={openLinkModalWithEditor} />
      <DragHandle editor={editor} />
      <MediaSelector editor={editor} postId={postId} />

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
}
