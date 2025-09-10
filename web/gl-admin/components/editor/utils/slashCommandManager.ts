import { ReactRenderer } from "@tiptap/react"
import { SlashCommandList } from "../ui/SlashCommand"

interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent; [key: string]: any }) => boolean
}

class SlashCommandManager {
  private component: ReactRenderer | null = null
  private popup: HTMLElement | null = null
  private isActive = false
  private currentEditor: any = null
  private currentRange: any = null
  private getCursorCoordsFunction: Function | null = null
  private scrollHandler: (() => void) | null = null

  isActiveState() {
    return this.isActive
  }

  cleanup() {
    this.isActive = false

    if (this.scrollHandler) {
      window.removeEventListener("scroll", this.scrollHandler, true)
      document.removeEventListener("scroll", this.scrollHandler, true)
      this.scrollHandler = null
    }

    if (this.popup && this.popup.parentNode) {
      this.popup.parentNode.removeChild(this.popup)
      this.popup = null
    }

    if (this.component) {
      this.component.destroy()
      this.component = null
    }

    this.currentEditor = null
    this.currentRange = null
    this.getCursorCoordsFunction = null
  }

  start(props: any, getCursorCoords: Function) {
    if (this.isActive) {
      this.update(props, getCursorCoords)
      return
    }

    this.isActive = true
    this.currentEditor = props.editor
    this.currentRange = props.range
    this.getCursorCoordsFunction = getCursorCoords

    // Use setTimeout to avoid flushSync error
    setTimeout(() => {
      if (!this.isActive) return // Check if still needed

      this.component = new ReactRenderer(SlashCommandList, {
        props: {
          ...props,
          editor: props.editor,
        },
        editor: props.editor,
      })

      this.popup = document.createElement("div")
      this.popup.className = "slash-command-popup"
      this.popup.appendChild(this.component.element)
      document.body.appendChild(this.popup)

      const coords = getCursorCoords(props.editor, props.range)
      this.positionPopup(coords)

      this.scrollHandler = () => {
        if (this.isActive && this.currentEditor && this.currentRange && this.getCursorCoordsFunction) {
          const newCoords = this.getCursorCoordsFunction(this.currentEditor, this.currentRange)
          this.positionPopup(newCoords)
        }
      }

      window.addEventListener("scroll", this.scrollHandler, true)
      document.addEventListener("scroll", this.scrollHandler, true)
    }, 0)
  }

  update(props: any, getCursorCoords: Function) {
    if (!this.isActive || !this.component) {
      return
    }

    this.currentRange = props.range
    this.getCursorCoordsFunction = getCursorCoords

    this.component.updateProps({
      ...props,
      editor: props.editor,
    })

    if (this.popup) {
      const coords = getCursorCoords(props.editor, props.range)
      this.positionPopup(coords)
    }
  }

  private positionPopup(coords: any) {
    if (!this.popup) return

    this.popup.style.position = "fixed"
    this.popup.style.left = `${coords.x}px`
    this.popup.style.top = `${coords.y + 8}px`
    this.popup.style.zIndex = "9999"
    this.popup.style.maxHeight = "300px"
    this.popup.style.overflowY = "auto"

    const popupRect = this.popup.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth

    if (coords.y + popupRect.height + 8 > viewportHeight) {
      this.popup.style.top = `${coords.y - popupRect.height - 8}px`
    }

    if (coords.x + popupRect.width > viewportWidth) {
      this.popup.style.left = `${viewportWidth - popupRect.width - 8}px`
    }

    if (coords.x < 0) {
      this.popup.style.left = `8px`
    }

    if (coords.y < popupRect.height + 16) {
      this.popup.style.top = `${coords.y + 24}px`
    }
  }

  handleKeyDown(props: any) {
    if (!this.isActive || !this.component) {
      return false
    }

    if (props.event.key === "Escape") {
      this.cleanup()
      return true
    }

    const componentRef = this.component.ref as SlashCommandListRef | null

    if (componentRef && typeof componentRef.onKeyDown === "function") {
      const handled = componentRef.onKeyDown(props)
      return handled
    } else {
      return false
    }
  }

  exit() {
    this.cleanup()
  }
}

export const slashCommandManager = new SlashCommandManager()
