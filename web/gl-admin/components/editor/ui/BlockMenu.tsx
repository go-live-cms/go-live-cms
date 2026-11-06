import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { BLOCK_COLOR_TOKENS, type BlockColor, type BlockColorToken } from "@gl-admin/lib/blocks-spec"
import { nextRovingIndex, useClickOutside, useFloating } from "@gl-admin/components/ui/a11y"
import { toast } from "@gl-admin/components/ui/Toast"
import { ChevronRightIcon } from "@gl-admin/components/ui/icons"
import { authManager } from "@gl-admin/lib/auth"
import { lastEditedLine } from "@gl-admin/lib/blockEdits"
import type { BlockEditsSnapshot } from "@gl-admin/lib/blockEditsStore"
import { BlockEditsContext } from "../blockEditsContext"
import {
  blockLink,
  canColor,
  deleteBlock,
  duplicateBlock,
  listHeadings,
  resolveBlock,
  setBlockColor,
  type BlockRef,
} from "../utils/blockActions"
import "@gl-admin/assets/styles/components/ui/menu.scss"

// The block menu (#356, "Editor menus & states" › Block menu): opened from the drag
// handle. Colour ›, Comment (#192, when the post has comments), Duplicate, Copy link to
// block, Move to, Delete, and under them "Last edited by <name> · <when>" (#328, from the
// API through BlockEditsContext; no line for a block with no attribution). Every action
// finds the block by its id when it runs (blockActions.ts), so a collaborator's edit while
// the menu is open never makes it act on another block.

const NO_EDITS: BlockEditsSnapshot = { edits: new Map(), users: new Map(), loaded: false }
const noSubscribe = () => () => {}
const noSnapshot = () => NO_EDITS

export const COLOR_LABELS: Record<BlockColorToken, string> = {
  gray: "Gray",
  brown: "Brown",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  red: "Red",
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const SHORTCUTS = {
  comment: isMac ? "⌘M" : "Ctrl M",
  duplicate: isMac ? "⌘D" : "Ctrl D",
  moveTo: isMac ? "⇧⌘P" : "Ctrl Shift P",
  delete: "Del",
}

const ITEM = "[role='menuitem']:not([aria-disabled='true']), [role='menuitemradio']"

type Props = {
  editor: TiptapEditor
  target: BlockRef
  anchor: RefObject<HTMLElement | null>
  // The post's public URL (null before it exists): Copy link to block.
  postUrl?: string | null
  onClose: (refocus: boolean) => void
  onMoveTo: (ref: BlockRef) => void
  // Opens a new comment thread on the block (#192); absent when comments aren't available.
  onComment?: (ref: BlockRef) => void
}

export default function BlockMenu({ editor, target, anchor, postUrl, onClose, onMoveTo, onComment }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const colorRef = useRef<HTMLButtonElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [colorsOpen, setColorsOpen] = useState(false)
  const { style, ready } = useFloating(anchor, menuRef, true, "bottom-start")
  const sub = useFloating(colorRef, subRef, colorsOpen, "right-start", { gap: 2 })

  const block = resolveBlock(editor.state.doc, target)
  const blockId = block?.node.attrs["data-block-id"] as string | undefined
  const link = blockLink(postUrl, blockId)
  const colorable = !!block && canColor(block.node)
  const current = (block?.node.attrs.blockColor as BlockColor | null | undefined) ?? null
  const canMove = !!block && listHeadings(editor.state.doc).some((h) => h.pos !== block.pos)
  const blockEdits = useContext(BlockEditsContext)
  const edits = useSyncExternalStore(blockEdits?.subscribe ?? noSubscribe, blockEdits?.getSnapshot ?? noSnapshot)
  const lastEdited = lastEditedLine(edits, blockId, authManager.getState().user?.id)
  const lastEditedId = useId()

  useClickOutside([menuRef, subRef, anchor], true, () => onClose(false))

  // Focus the first item once placed; the open submenu's first item when it opens.
  useEffect(() => {
    if (ready) items(menuRef.current)[0]?.focus()
  }, [ready])
  useEffect(() => {
    if (colorsOpen && sub.ready) items(subRef.current)[0]?.focus()
  }, [colorsOpen, sub.ready])

  // The block was deleted (by someone else) while the menu was open.
  useEffect(() => {
    if (!block) onClose(false)
  }, [block, onClose])

  const run = (action: () => void) => {
    onClose(false)
    action()
    if (!editor.isDestroyed) editor.commands.focus()
  }

  const gone = () => toast.warning("That block isn't in the post any more")

  const copyLink = async () => {
    onClose(false)
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      // The anchor is on the public page: the link reaches the block once it's published.
      toast.success("Link copied. It opens this block on the live post once it's published.", { duration: 4000 })
    } catch {
      toast.error("Couldn't copy the link")
    }
  }

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>, root: HTMLElement | null, isSub: boolean) => {
    const list = items(root)
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === "Escape" || (isSub && e.key === "ArrowLeft")) {
      e.preventDefault()
      e.stopPropagation()
      if (isSub) {
        setColorsOpen(false)
        colorRef.current?.focus()
      } else onClose(true)
      return
    }
    if (e.key === "Tab") {
      onClose(false)
      return
    }
    // The "Del" the menu shows next to Delete.
    if (!isSub && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault()
      run(() => {
        if (!deleteBlock(editor, target)) gone()
      })
      return
    }
    if (!isSub && e.key === "ArrowRight" && document.activeElement === colorRef.current) {
      e.preventDefault()
      setColorsOpen(true)
      return
    }
    const next = nextRovingIndex(e.key, at, list.length, "vertical")
    if (next === null) return
    e.preventDefault()
    list[next]?.focus()
  }

  const pickColor = (color: BlockColor | null) =>
    run(() => {
      if (!setBlockColor(editor, target, color)) gone()
    })

  const host = typeof document !== "undefined" ? (document.getElementById("admin") ?? document.body) : null
  if (!host) return null

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Block actions"
        aria-describedby={lastEdited ? lastEditedId : undefined}
        className="gl-menu editor-block-menu"
        style={style}
        onKeyDown={(e) => onMenuKeyDown(e, menuRef.current, false)}
      >
        {colorable && (
          <>
            <Item
              ref={colorRef}
              hint={<ChevronRightIcon size={14} />}
              haspopup
              expanded={colorsOpen}
              onSelect={() => setColorsOpen((open) => !open)}
              onHover={() => setColorsOpen(true)}
            >
              Colour
            </Item>
            <div role="separator" className="gl-menu__separator" />
          </>
        )}
        {onComment && (
          <Item
            hint={SHORTCUTS.comment}
            disabled={!blockId}
            description={!blockId ? "Wait a moment: the block is being saved" : undefined}
            onHover={() => setColorsOpen(false)}
            onSelect={() => {
              onClose(false)
              if (block) onComment(target)
              else gone()
            }}
          >
            Comment
          </Item>
        )}
        <Item
          hint={SHORTCUTS.duplicate}
          onHover={() => setColorsOpen(false)}
          onSelect={() =>
            run(() => {
              if (duplicateBlock(editor, target) === null) gone()
            })
          }
        >
          Duplicate
        </Item>
        <Item
          disabled={!link}
          description={!link ? "Save the post first" : undefined}
          onHover={() => setColorsOpen(false)}
          onSelect={copyLink}
        >
          Copy link to block
        </Item>
        <Item
          hint={SHORTCUTS.moveTo}
          disabled={!canMove}
          description={!canMove ? "Add a heading to move blocks under it" : undefined}
          onHover={() => setColorsOpen(false)}
          onSelect={() => {
            onClose(false)
            onMoveTo(target)
          }}
        >
          Move to
        </Item>
        <div role="separator" className="gl-menu__separator" />
        <Item
          hint={SHORTCUTS.delete}
          danger
          onHover={() => setColorsOpen(false)}
          onSelect={() =>
            run(() => {
              if (!deleteBlock(editor, target)) gone()
            })
          }
        >
          Delete
        </Item>
        {lastEdited && (
          <div id={lastEditedId} className="editor-block-menu__meta">
            {lastEdited}
          </div>
        )}
      </div>
      {colorsOpen && (
        <div
          ref={subRef}
          role="menu"
          aria-label="Colour"
          className="gl-menu editor-block-menu editor-block-menu--colors"
          style={sub.style}
          onKeyDown={(e) => onMenuKeyDown(e, subRef.current, true)}
        >
          <div className="editor-block-menu__group" aria-hidden="true">
            Text
          </div>
          <ColorItem color={null} checked={current === null} onSelect={() => pickColor(null)}>
            Default
          </ColorItem>
          {BLOCK_COLOR_TOKENS.map((token) => (
            <ColorItem key={token} color={token} checked={current === token} onSelect={() => pickColor(token)}>
              {COLOR_LABELS[token]}
            </ColorItem>
          ))}
          <div role="separator" className="gl-menu__separator" />
          <div className="editor-block-menu__group" aria-hidden="true">
            Background
          </div>
          {BLOCK_COLOR_TOKENS.map((token) => {
            const color = `${token}-background` as BlockColor
            return (
              <ColorItem key={color} color={color} checked={current === color} onSelect={() => pickColor(color)}>
                {`${COLOR_LABELS[token]} background`}
              </ColorItem>
            )
          })}
        </div>
      )}
    </>,
    host
  )
}

function items(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(ITEM) ?? [])
}

type ItemProps = {
  children: ReactNode
  onSelect: () => void
  onHover?: () => void
  hint?: ReactNode
  description?: string
  danger?: boolean
  disabled?: boolean
  haspopup?: boolean
  expanded?: boolean
  ref?: RefObject<HTMLButtonElement | null>
}

function Item({ children, onSelect, onHover, hint, description, danger, disabled, haspopup, expanded, ref }: ItemProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      aria-haspopup={haspopup ? "menu" : undefined}
      aria-expanded={haspopup ? expanded : undefined}
      className={`gl-menu__item editor-block-menu__item${danger ? " gl-menu__item--danger" : ""}${description ? " gl-menu__item--described" : ""}`}
      onMouseMove={(e) => {
        if (!disabled && document.activeElement !== e.currentTarget) e.currentTarget.focus()
        onHover?.()
      }}
      onClick={() => !disabled && onSelect()}
    >
      <span className="gl-menu__text">
        <span className="gl-menu__label">{children}</span>
        {description && <span className="gl-menu__description">{description}</span>}
      </span>
      {hint && (
        <span className="editor-block-menu__hint" aria-hidden={typeof hint === "string" ? undefined : true}>
          {hint}
        </span>
      )}
    </button>
  )
}

function ColorItem({
  color,
  checked,
  onSelect,
  children,
}: {
  color: BlockColor | null
  checked: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      className="gl-menu__item editor-block-menu__item"
      onMouseMove={(e) => document.activeElement !== e.currentTarget && e.currentTarget.focus()}
      onClick={onSelect}
    >
      <span className="editor-block-menu__swatch" data-block-color={color ?? undefined} aria-hidden="true">
        A
      </span>
      <span className="gl-menu__text">
        <span className="gl-menu__label">{children}</span>
      </span>
      {checked && (
        <svg className="editor-block-menu__check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  )
}
