import { NodeSelection } from '@tiptap/pm/state'
import type { Editor as TiptapEditor } from '@tiptap/core'
import type { CommandSelectOption } from '../ui/CommandSelect'

export type TurnIntoValue =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'numbered-list'
  | 'quote'
  | 'code-block'
  | 'divider'
  | 'image'

export const computeTurnIntoFromSelection = (editor: TiptapEditor): TurnIntoValue => {
  const { state } = editor
  const sel = state.selection

  if (sel instanceof NodeSelection && sel.node) {
    const node = sel.node
    if (node.type.name === 'image') return 'image'
    if (node.type.name === 'horizontalRule') return 'divider'
    if (node.type.name === 'codeBlock') return 'code-block'
    if (node.type.name === 'blockquote') return 'quote'
    if (node.type.name === 'orderedList') return 'numbered-list'
    if (node.type.name === 'bulletList') return 'bullet-list'
    if (node.type.name === 'heading') {
      const lvl = (node.attrs?.level ?? 1) as 1 | 2 | 3
      return (`heading-${Math.min(Math.max(lvl, 1), 3)}`) as TurnIntoValue
    }
    return 'paragraph'
  }

  if (editor.isActive('codeBlock')) return 'code-block'
  if (editor.isActive('blockquote')) return 'quote'
  if (editor.isActive('orderedList')) return 'numbered-list'
  if (editor.isActive('bulletList')) return 'bullet-list'

  if (editor.isActive('heading', { level: 1 })) return 'heading-1'
  if (editor.isActive('heading', { level: 2 })) return 'heading-2'
  if (editor.isActive('heading', { level: 3 })) return 'heading-3'

  const $from = sel.$from
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'horizontalRule') return 'divider'
    if (node.type.name === 'image') return 'image'
  }

  return 'paragraph'
}

export const applyTurnInto = (
  editor: TiptapEditor,
  value: TurnIntoValue,
  options: CommandSelectOption[]
) => {
  const opt = options.find(o => o.value === value)
  if (opt?.command) {
    opt.command({ editor, range: editor.state.selection })
    return
  }

  // Fallbacks
  const chain = editor.chain().focus()
  switch (value) {
    case 'paragraph':
      chain.setParagraph().run()
      break
    case 'heading-1':
      chain.setHeading({ level: 1 }).run()
      break
    case 'heading-2':
      chain.setHeading({ level: 2 }).run()
      break
    case 'heading-3':
      chain.setHeading({ level: 3 }).run()
      break
    case 'bullet-list':
      if (editor.isActive('orderedList')) chain.toggleOrderedList()
      chain.toggleBulletList().run()
      break
    case 'numbered-list':
      if (editor.isActive('bulletList')) chain.toggleBulletList()
      chain.toggleOrderedList().run()
      break
    case 'quote':
      chain.toggleBlockquote().run()
      break
    case 'code-block':
      chain.toggleCodeBlock().run()
      break
    case 'divider':
      chain.setHorizontalRule().run()
      break
    case 'image':
      break
    default:
      break
  }
}
