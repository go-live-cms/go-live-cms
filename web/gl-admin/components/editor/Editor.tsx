import React, { useEffect, useState, useCallback, useMemo } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCursor from "@tiptap/extension-collaboration-cursor"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import Underline from "@tiptap/extension-underline"
import TextAlign from "@tiptap/extension-text-align"
import CharacterCount from "@tiptap/extension-character-count"
import Typography from "@tiptap/extension-typography"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { SlashCommandExtension } from "./SlashCommand"
import { slashCommandManager } from "./SlashCommandManager"
import { getAllBlocks } from "./blocks"
import { MediaBlockManager } from "./blocks/mediaBlocks"
import FeaturedImageSelector from "./FeaturedImageSelector"
import { CollaborationProvider } from "@gl-admin/lib/collaboration/CollaborationProvider"
import type { Media } from "@gl-admin/lib/api/types"
import "@gl-admin/assets/styles/components/editor/editor.scss"

type Props = {
  value: string
  onChange: (html: string, plainText: string) => void
  placeholder?: string
  readOnly?: boolean
  minChars?: number
  maxChars?: number
  postId?: number
  enableCollaboration?: boolean // New prop to enable/disable collaboration
}

const lowlight = createLowlight(common)

export default function Editor({
  value,
  onChange,
  placeholder = "Type '/' for commands...",
  readOnly = false,
  minChars,
  maxChars,
  postId,
  enableCollaboration = true, // Enable by default for edit mode
}: Props) {
  const [showMediaSelector, setShowMediaSelector] = useState(false)
  const [pendingImagePosition, setPendingImagePosition] = useState<number | null>(null)
  const [mediaBlockManager, setMediaBlockManager] = useState<MediaBlockManager | null>(null)
  const [collaborationProvider, setCollaborationProvider] = useState<CollaborationProvider | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const [connectedUsers, setConnectedUsers] = useState<any[]>([])

  // Create collaboration provider when postId is available and collaboration is enabled
  const collabProvider = useMemo(() => {
    if (postId && enableCollaboration && !readOnly) {
      return new CollaborationProvider(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly])

  // Setup collaboration provider effects
  useEffect(() => {
    if (collabProvider) {
      setCollaborationProvider(collabProvider)

      // Listen for connection status changes
      const updateStatus = () => {
        setConnectionStatus(collabProvider.getConnectionStatus() === 'connected' ? 'connected' : 'connecting')
      }

      // Listen for user presence changes
      const updateUsers = () => {
        setConnectedUsers(collabProvider.getConnectedUsers())
      }

      collabProvider.provider.on('status', updateStatus)
      collabProvider.provider.awareness.on('change', updateUsers)

      // Initial status
      updateStatus()
      updateUsers()

      return () => {
        collabProvider.provider.off('status', updateStatus)
        collabProvider.provider.awareness.off('change', updateUsers)
        collabProvider.destroy()
      }
    }
  }, [collabProvider])

  const getSlashCommands = useCallback((editor: TiptapEditor) => {
    return getAllBlocks()
  }, [])

  const getCursorCoords = useCallback((editor: TiptapEditor, range: { from: number; to: number }) => {
    const { view } = editor
    const { from } = range

    try {
      const coords = view.coordsAtPos(from)
      return {
        x: coords.left,
        y: coords.bottom,
        left: coords.left,
        right: coords.right,
        top: coords.top,
        bottom: coords.bottom,
        width: coords.right - coords.left,
        height: coords.bottom - coords.top,
      }
    } catch (error) {
      const editorRect = view.dom.getBoundingClientRect()
      return {
        x: editorRect.left + 20,
        y: editorRect.top + 40,
        left: editorRect.left + 20,
        right: editorRect.left + 40,
        top: editorRect.top + 20,
        bottom: editorRect.top + 40,
        width: 20,
        height: 20,
      }
    }
  }, [])

  // Create editor extensions based on collaboration mode
  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        dropcursor: { width: 2, color: "var(--editor-cursor,#3b82f6)" },
        link: false,
        // Disable history when using collaboration (Yjs handles this)
        history: !collabProvider,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "javascript",
      }),
      Typography,
      Underline,
      Link.configure({
        autolink: true,
        openOnClick: false,
        validate: (href) => /^https?:\/\//.test(href),
        HTMLAttributes: {
          class: "editor-link",
        },
      }),
      Image.configure({
        allowBase64: false,
        HTMLAttributes: {
          class: "editor-image",
        },
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder }),
      CharacterCount.configure({ limit: maxChars }),
      SlashCommandExtension.configure({
        suggestion: {
          items: ({ query }: { query: string }) => {
            const commands = getSlashCommands(editor!)
            return commands
              .filter((item) => {
                const searchTerm = query.toLowerCase()
                return (
                  item.title.toLowerCase().includes(searchTerm) ||
                  item.description.toLowerCase().includes(searchTerm) ||
                  (item.aliases && item.aliases.some((alias) => alias.includes(searchTerm)))
                )
              })
              .slice(0, 10)
          },
          render: () => ({
            onStart: (props: any) => slashCommandManager.start(props, getCursorCoords),
            onUpdate: (props: any) => slashCommandManager.update(props, getCursorCoords),
            onKeyDown: (props: any) => slashCommandManager.handleKeyDown(props),
            onExit: () => slashCommandManager.exit(),
          }),
        },
      }),
    ]

    // Add collaboration extensions if provider is available
    if (collabProvider) {
      baseExtensions.push(
        Collaboration.configure({
          document: collabProvider.doc,
        }),
        CollaborationCursor.configure({
          provider: collabProvider.provider,
          user: {
            name: connectedUsers.find(u => u.id === collabProvider.provider.awareness.clientID)?.name || 'You',
            color: connectedUsers.find(u => u.id === collabProvider.provider.awareness.clientID)?.color || '#FF6B6B',
          },
        })
      )
    }

    return baseExtensions
  }, [collabProvider, connectedUsers, getSlashCommands, getCursorCoords, maxChars, placeholder])

  const editor = useEditor({
    editable: !readOnly,
    extensions,
    // Only set initial content if not using collaboration
    content: !collabProvider ? (value || "<p></p>") : undefined,
    autofocus: "end",
    onUpdate({ editor }) {
      const html = editor.getHTML()
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, " ")
      onChange(html, text)
    },
    editorProps: {
      attributes: {
        class: "ProseMirror notion-editor-content",
        "data-placeholder": placeholder,
      },
    },
  }, [collabProvider]) // Re-create editor when collaboration changes

  // Handle content updates for non-collaborative mode
  useEffect(() => {
    if (editor && !collabProvider && value !== editor.getHTML()) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor, collabProvider])

  // Setup media block manager
  useEffect(() => {
    if (editor) {
      const manager = new MediaBlockManager(
        editor,
        postId,
        (position: number) => {
          setPendingImagePosition(position)
          setShowMediaSelector(true)
        }
      )
      setMediaBlockManager(manager)

      return () => {
        manager.destroy()
      }
    }
  }, [editor, postId])

  const handleMediaSelect = useCallback(async (media: Media) => {
    if (!mediaBlockManager || pendingImagePosition === null) return
    
    await mediaBlockManager.handleMediaSelect(media, pendingImagePosition)
    
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [mediaBlockManager, pendingImagePosition])

  const handleMediaSelectorClose = useCallback(() => {
    setShowMediaSelector(false)
    setPendingImagePosition(null)
  }, [])

  if (!editor) return null

  return (
    <div className="notion-editor">
      {/* Collaboration Status Bar */}
      {enableCollaboration && postId && (
        <div className={`collaboration-status collaboration-status--${connectionStatus}`}>
          <div className="collaboration-info">
            <span className={`status-indicator status-indicator--${connectionStatus}`}></span>
            <span className="status-text">
              {connectionStatus === 'connected' ? 'Connected' : 
               connectionStatus === 'connecting' ? 'Connecting...' : 'Offline'}
            </span>
            {connectedUsers.length > 1 && (
              <span className="user-count">
                {connectedUsers.length - 1} other{connectedUsers.length === 2 ? '' : 's'} editing
              </span>
            )}
          </div>
          
          {connectedUsers.length > 1 && (
            <div className="connected-users">
              {connectedUsers
                .filter(user => user.id !== collabProvider?.provider.awareness.clientID)
                .slice(0, 3)
                .map((user, index) => (
                  <div 
                    key={user.id} 
                    className="user-avatar"
                    style={{ backgroundColor: user.color }}
                    title={user.name}
                  >
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                ))
              }
              {connectedUsers.length > 4 && (
                <div className="user-avatar user-avatar--more">
                  +{connectedUsers.length - 4}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bubble Menu - appears when text is selected */}
      <BubbleMenu editor={editor} className="bubble-menu">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`bubble-menu-btn ${editor.isActive("bold") ? "active" : ""}`}
          type="button"
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`bubble-menu-btn ${editor.isActive("italic") ? "active" : ""}`}
          type="button"
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`bubble-menu-btn ${editor.isActive("underline") ? "active" : ""}`}
          type="button"
        >
          <u>U</u>
        </button>
        <button
          onClick={() => {
            const url = window.prompt("URL")
            if (url) editor.chain().focus().setLink({ href: url }).run()
          }}
          className={`bubble-menu-btn ${editor.isActive("link") ? "active" : ""}`}
          type="button"
        >
          🔗
        </button>
      </BubbleMenu>

      {/* Main Editor */}
      <div className="editor-wrapper">
        <EditorContent editor={editor} />
      </div>

      {/* Character Count */}
      <div className="editor-meta">
        <span className="char-count">{editor.storage.characterCount.characters()} characters</span>
        {typeof minChars === "number" && (
          <span className="char-limit">
            min {minChars}
            {editor.storage.characterCount.characters() < minChars ? " • too short" : ""}
          </span>
        )}
        {typeof maxChars === "number" && (
          <span className="char-limit">
            max {maxChars}
            {editor.storage.characterCount.characters() > maxChars ? " • too long" : ""}
          </span>
        )}
      </div>

      {showMediaSelector && (
        <FeaturedImageSelector
          isOpen={showMediaSelector}
          onClose={handleMediaSelectorClose}
          onSelect={handleMediaSelect}
          currentFeaturedImage={null}
        />
      )}
    </div>
  )
}