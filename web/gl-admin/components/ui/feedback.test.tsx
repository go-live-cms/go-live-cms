import { act, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Input from "./Input"
import Combobox from "./Combobox"
import Modal from "./Modal"
import Button from "./Button"
import Tooltip, { TOOLTIP_HIDE_DELAY_MS } from "./Tooltip"
import { Toaster, TOASTER_SHORTCUT, dismissToast, toast, toastDuration, useToasts } from "./Toast"
import { installSubmitFocus } from "./a11y"

// Form errors, toasts and tooltips (#479): what a screen reader or keyboard user gets
// from them. Rendered with react-dom into jsdom; keys are native keydown events.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function render(ui: ReactElement) {
  await act(async () => root.render(ui))
}

async function press(key: string, target: Element | null = document.activeElement) {
  await act(async () => {
    ;(target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

const label = (text: string) => Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.startsWith(text))!
const fieldFor = (text: string) => document.getElementById(label(text).htmlFor) as HTMLInputElement

describe("Input", () => {
  it("gives each unnamed input its own id, so every label points at its field", async () => {
    await render(
      <>
        <Input title="First" unmasked />
        <Input title="Second" unmasked />
      </>
    )
    const [a, b] = Array.from(container.querySelectorAll("input"))
    expect(a.id).not.toBe(b.id)
    expect(fieldFor("First")).toBe(a)
    expect(fieldFor("Second")).toBe(b)
  })

  it("is a focusable field the label points at before the mask loads", async () => {
    // Synchronous render: react-imask's import hasn't resolved yet.
    act(() => root.render(<Input title="Email" type="email" />))
    const field = fieldFor("Email")
    expect(field?.tagName).toBe("INPUT")
    field.focus()
    expect(document.activeElement).toBe(field)
  })

  it("marks the field invalid only with a message, and announces the message", async () => {
    // A value the email pattern rejects, but no error message: red edge, not "invalid".
    await render(<Input title="Email" type="email" value="maya@golive" onChange={() => {}} />)
    await act(async () => {
      await import("react-imask")
    })
    let field = fieldFor("Email")
    expect(field.hasAttribute("aria-invalid")).toBe(false)
    expect(container.querySelector(".gl-input")!.classList.contains("is-invalid")).toBe(true)

    await render(<Input title="Email" type="email" value="maya@golive" onChange={() => {}} error="“maya@golive” isn't a complete email address." />)
    field = fieldFor("Email")
    expect(field.getAttribute("aria-invalid")).toBe("true")
    const error = document.getElementById(field.getAttribute("aria-describedby")!)!
    expect(error.getAttribute("role")).toBe("alert")
    expect(error.textContent).toContain("isn't a complete email address")
  })
})

describe("focus after a failed submit", () => {
  installSubmitFocus()

  function Form() {
    const [errors, setErrors] = useState<{ name?: string; email?: string }>({})
    return (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setErrors({ email: "Enter an email address." })
        }}
      >
        <Input title="Name" unmasked error={errors.name} />
        <Input title="Email" unmasked error={errors.email} />
        <button type="submit">Save</button>
      </form>
    )
  }

  it("moves focus to the first invalid field", async () => {
    await render(<Form />)
    const save = container.querySelector<HTMLButtonElement>("button[type=submit]")!
    save.focus()
    await act(async () => {
      save.click()
      await new Promise((r) => requestAnimationFrame(r))
    })
    expect(document.activeElement).toBe(fieldFor("Email"))
  })

  it("doesn't take focus the user moved elsewhere", async () => {
    const outside = document.createElement("button")
    document.body.appendChild(outside)
    await render(<Form />)
    await act(async () => {
      container.querySelector("form")!.requestSubmit()
      outside.focus()
      await new Promise((r) => requestAnimationFrame(r))
    })
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})

describe("Combobox", () => {
  const options = [
    { value: "1", label: "Ana Costa" },
    { value: "2", label: "Kenji Sato" },
  ]

  it("Escape with the list closed keeps the value and closes the dialog around it", async () => {
    const onChange = vi.fn()
    const onClose = vi.fn()
    await render(
      <Modal isOpen onClose={onClose} title="Transfer">
        <Combobox label="New owner" options={options} value="2" onChange={onChange} />
      </Modal>
    )
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!
    input.focus()
    await press("Escape", input)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe("Kenji Sato")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Escape with the list open closes only the list", async () => {
    const onClose = vi.fn()
    await render(
      <Modal isOpen onClose={onClose} title="Transfer">
        <Combobox label="New owner" options={options} value="2" onChange={() => {}} />
      </Modal>
    )
    const input = document.querySelector<HTMLInputElement>("[role='combobox']")!
    input.focus()
    await press("ArrowDown", input)
    expect(input.getAttribute("aria-expanded")).toBe("true")
    await press("Escape", input)
    expect(input.getAttribute("aria-expanded")).toBe("false")
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("Toast timing", () => {
  function Clear() {
    const all = useToasts()
    return <span data-count={all.length} />
  }
  const count = () => Number(container.querySelector("[data-count]")!.getAttribute("data-count"))

  beforeEach(() => {
    for (const t of [...document.querySelectorAll("[data-toast-id]")]) dismissToast(t.getAttribute("data-toast-id")!)
  })
  afterEach(async () => {
    await act(async () => {
      for (const t of [...document.querySelectorAll("[data-toast-id]")]) dismissToast(t.getAttribute("data-toast-id")!)
    })
  })

  it("keeps errors and toasts with an action until dismissed", () => {
    expect(toastDuration("error")).toBe(Infinity)
    expect(toastDuration("error", { duration: 3000 })).toBe(Infinity)
    expect(toastDuration("success", { action: { label: "Undo", onClick: () => {} } })).toBe(Infinity)
    expect(toastDuration("success")).toBe(4000)
    expect(toastDuration("info", { duration: 5000 })).toBe(5000)
  })

  it("hides confirmations after their time, never errors or Undo", async () => {
    vi.useFakeTimers()
    await render(
      <>
        <Toaster />
        <Clear />
      </>
    )
    await act(async () => {
      toast.success("Post published")
      toast.error("Couldn't publish “Spring launch”")
      toast.success("Moved to trash", { action: { label: "Undo", onClick: () => {} } })
    })
    expect(count()).toBe(3)
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(count()).toBe(2)
    expect(container.textContent).toContain("Couldn't publish")
    expect(container.textContent).toContain("Undo")
  })

  it("a burst of confirmations doesn't push out an error", async () => {
    await render(
      <>
        <Toaster />
        <Clear />
      </>
    )
    await act(async () => {
      toast.error("Couldn't save")
      toast.success("One")
      toast.success("Two")
      toast.success("Three")
    })
    expect(count()).toBe(3)
    expect(container.textContent).toContain("Couldn't save")
    expect(container.textContent).not.toContain("One")
  })

  it(`${TOASTER_SHORTCUT} goes to the newest toast and back, and dismissing it returns focus`, async () => {
    const field = document.createElement("input")
    document.body.appendChild(field)
    field.focus()
    await render(<Toaster />)
    // Nothing to reach: the key is left to the browser.
    const unclaimed = new KeyboardEvent("keydown", { key: TOASTER_SHORTCUT, bubbles: true, cancelable: true })
    field.dispatchEvent(unclaimed)
    expect(unclaimed.defaultPrevented).toBe(false)

    await act(async () => {
      toast.success("Saved")
      toast.success("Moved to trash", { action: { label: "Undo", onClick: () => {} } })
    })
    expect(container.textContent).toContain(`Press ${TOASTER_SHORTCUT} to go to it.`)
    await press(TOASTER_SHORTCUT, field)
    expect(document.activeElement?.textContent).toBe("Undo")
    await press(TOASTER_SHORTCUT)
    expect(document.activeElement).toBe(field)

    await press(TOASTER_SHORTCUT, field)
    await act(async () => (document.activeElement as HTMLButtonElement).click())
    expect(container.textContent).not.toContain("Undo")
    expect(document.activeElement).toBe(field)
    field.remove()
  })

  it("the toaster is left out of a dialog's inert", async () => {
    await render(
      <>
        <Toaster />
        <Modal isOpen onClose={() => {}} title="Invite people">
          <input aria-label="Email" />
        </Modal>
      </>
    )
    expect(container.querySelector(".gl-toaster")!.hasAttribute("inert")).toBe(false)
  })
})

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const hover = async (el: Element, type: "mouseover" | "mouseout") => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }))
    })
  }

  it("stays while the pointer moves from the target onto it, then hides", async () => {
    await render(
      <Tooltip content="Editing" detail="Click to jump to cursor">
        <button type="button">Ana</button>
      </Tooltip>
    )
    const target = container.querySelector(".gl-tooltip-target")!
    await hover(target, "mouseover")
    expect(document.querySelector("[role='tooltip']")).not.toBeNull()
    await hover(target, "mouseout")
    await act(async () => {
      vi.advanceTimersByTime(TOOLTIP_HIDE_DELAY_MS / 2)
    })
    const tip = document.querySelector("[role='tooltip']")!
    expect(tip).not.toBeNull()
    await hover(tip, "mouseover")
    await act(async () => {
      vi.advanceTimersByTime(TOOLTIP_HIDE_DELAY_MS * 3)
    })
    expect(document.querySelector("[role='tooltip']")).not.toBeNull()
    await hover(tip, "mouseout")
    await act(async () => {
      vi.advanceTimersByTime(TOOLTIP_HIDE_DELAY_MS + 1)
    })
    expect(document.querySelector("[role='tooltip']")).toBeNull()
  })

  it("describes a component's element too, before it is shown", async () => {
    await render(
      <Tooltip content="Editing" detail="Click to jump to cursor">
        <Button variant="ghost">Ana Costa</Button>
      </Tooltip>
    )
    const button = container.querySelector("button")!
    const description = document.getElementById(button.getAttribute("aria-describedby")!)
    expect(description?.textContent).toBe("Editing Click to jump to cursor")
  })

  it("doesn't repeat a name as the description", async () => {
    await render(
      <Tooltip content="Bold">
        <button type="button" aria-label="Bold">
          B
        </button>
      </Tooltip>
    )
    expect(container.querySelector("button")!.hasAttribute("aria-describedby")).toBe(false)
  })
})
