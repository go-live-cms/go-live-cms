import React, { useEffect, useState, useCallback, useMemo } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCursor from "@tiptap/extension-collaboration-cursor"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
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
  enableCollaboration?: boolean 
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
  enableCollaboration = true, 
}: Props) {
  const [showMediaSelector, setShowMediaSelector] = useState(false)
  const [pendingImagePosition, setPendingImagePosition] = useState<number | null>(null)
  const [mediaBlockManager, setMediaBlockManager] = useState<MediaBlockManager | null>(null)
  const [collaborationProvider, setCollaborationProvider] = useState<CollaborationProvider | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const [connectedUsers, setConnectedUsers] = useState<any[]>([])

  
  const collabProvider = useMemo(() => {
    if (postId && enableCollaboration && !readOnly) {
      return CollaborationProvider.getInstance(postId)
    }
    return null
  }, [postId, enableCollaboration, readOnly])

  
  useEffect(() => {
    if (collabProvider) {
      setCollaborationProvider(collabProvider)
      setConnectionStatus('connecting')

      
      const updateStatus = () => {
        
        setTimeout(() => {
          const status = collabProvider.getConnectionStatus()
          console.log('Connection status update:', status)
          setConnectionStatus(status)
        }, 0)
      }

      
      const updateUsers = () => {
        
        setTimeout(() => {
          const users = collabProvider.getConnectedUsers()
          console.log('Connected users update:', users.length)
          setConnectedUsers(users)
        }, 0)
      }

      
      const statusTimer = setInterval(updateStatus, 1000) 
      
      collabProvider.provider.on('status', updateStatus)
      collabProvider.provider.on('connect', updateStatus)
      collabProvider.provider.on('disconnect', updateStatus)
      collabProvider.provider.awareness.on('change', updateUsers)

      
      updateStatus()
      updateUsers()

      return () => {
        clearInterval(statusTimer)
        collabProvider.provider.off('status', updateStatus)
        collabProvider.provider.off('connect', updateStatus)
        collabProvider.provider.off('disconnect', updateStatus)
        collabProvider.provider.awareness.off('change', updateUsers)
        
      }
    } else {
      setConnectionStatus('disconnected')
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

  
  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        dropcursor: { width: 2, color: "var(--editor-cursor,#3b82f6)" },
        link: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "javascript",
      }),
      Typography,
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
            return getAllBlocks()
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

    
    if (collabProvider) {
      const userState = collabProvider.provider.awareness.getLocalState()
      console.log('Setting up collaboration for user:', userState?.user)
      console.log('CollabProvider doc exists:', !!collabProvider.doc)
      console.log('CollabProvider provider exists:', !!collabProvider.provider)
      
      
      if (collabProvider.doc && collabProvider.provider && collabProvider.provider.awareness) {
        baseExtensions.push(
          Collaboration.configure({
            document: collabProvider.doc,
          })
        )
        
        console.log('Added Collaboration extension successfully')
        
        
        /*
        try {
          const cursorExtension = CollaborationCursor.configure({
            provider: collabProvider.provider,
            user: userState?.user || {
              name: 'Anonymous',
              color: '#3b82f6',
            },
          })
          baseExtensions.push(cursorExtension)
          console.log('Added CollaborationCursor extension successfully')
        } catch (error) {
          console.error('Failed to add CollaborationCursor:', error)
          
          console.log('Proceeding without cursors')
        }
        */
      } else {
        console.warn('CollaborationProvider not fully initialized, skipping collaboration extensions')
      }
    }

    return baseExtensions
  }, [collabProvider, maxChars, placeholder])


  const editor = useEditor({
    editable: !readOnly,
    extensions,
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
  })

  useEffect(() => {
    if (collabProvider) {
      setCollaborationProvider(collabProvider)
      setConnectionStatus('connecting')

      
      const updateStatus = () => {
        
        setTimeout(() => {
          const status = collabProvider.getConnectionStatus()
          console.log('Connection status update:', status)
          setConnectionStatus(status)
        }, 0)
      }

      
      const updateUsers = () => {
        
        setTimeout(() => {
          const users = collabProvider.getConnectedUsers()
          console.log('Connected users update:', users.length)
          setConnectedUsers(users)
        }, 0)
      }

      
      const statusTimer = setInterval(updateStatus, 1000) 
      
      collabProvider.provider.on('status', updateStatus)
      collabProvider.provider.on('connect', updateStatus)
      collabProvider.provider.on('disconnect', updateStatus)
      collabProvider.provider.awareness.on('change', updateUsers)

      
      updateStatus()
      updateUsers()

      return () => {
        clearInterval(statusTimer)
        
        
        collabProvider.provider.off('status', updateStatus)
        collabProvider.provider.off('connect', updateStatus)
        collabProvider.provider.off('disconnect', updateStatus)
        collabProvider.provider.awareness.off('change', updateUsers)
      }
    } else {
      setConnectionStatus('disconnected')
      setConnectedUsers([])
    }
  }, [collabProvider])

  
  useEffect(() => {
    if (editor && collabProvider && connectionStatus === 'connected' && value && value !== '<p></p>') {
      
      const timeout = setTimeout(() => {
        const currentHTML = editor.getHTML()
        const isEmpty = currentHTML === '<p></p>' || currentHTML === '' || !currentHTML.trim()
        
        console.log('Checking initial content:', { currentHTML, isEmpty, hasValue: !!value })
        
        if (isEmpty && value && value !== '<p></p>') {
          console.log('Setting initial content for collaboration:', value.substring(0, 100))
          editor.commands.setContent(value, { emitUpdate: false })
        }
      }, 2000) 

      return () => clearTimeout(timeout)
    }
  }, [editor, collabProvider, connectionStatus, value])

  
  useEffect(() => {
    if (editor && !collabProvider && value !== editor.getHTML()) {
      editor.commands.setContent(value || "<p></p>", {
        emitUpdate: false,
      })
    }
  }, [value, editor, collabProvider])

  
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
      {}
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
                    key={`user-${user.id}-${user.name}-${index}`}  
                    className="user-avatar"
                    style={{ backgroundColor: user.color }}
                    title={user.name}
                  >
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                ))
              }
              {connectedUsers.length > 4 && (
                <div key="more-users" className="user-avatar user-avatar--more">
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