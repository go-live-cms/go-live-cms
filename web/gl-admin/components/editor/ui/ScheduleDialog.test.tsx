import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ScheduleDialog from "./ScheduleDialog"

// The Schedule dialog (#147): it starts from the current schedule (or tomorrow 09:00 site
// time), picks days on the calendar, shows the site's zone with the offset at the picked
// time, refuses a time the clocks skip before sending, and sends the wall-clock time.

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
})

const newYork = { language: "en-US", timeZone: "America/New_York" } as const
// Noon UTC on 2026-03-01: 07:00 in New York, a week before the clocks spring forward.
const now = () => new Date("2026-03-01T12:00:00Z")

function render(
  props: { publishAt?: string | null; onSchedule?: (local: string) => Promise<void>; mode?: "publish" | "update" } = {}
) {
  const onSchedule = props.onSchedule ?? vi.fn(async () => {})
  const onClose = vi.fn()
  act(() =>
    root.render(
      <ScheduleDialog
        isOpen
        onClose={onClose}
        publishAt={props.publishAt ?? null}
        settings={newYork}
        onSchedule={onSchedule}
        mode={props.mode}
        now={now}
      />
    )
  )
  return { onSchedule, onClose }
}

const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector)
const byText = (text: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!
const timeInput = () => document.body.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!

function setTime(value: string) {
  const input = timeInput()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.click()
  })
}

describe("ScheduleDialog", () => {
  it("starts tomorrow at 09:00 in the site's zone and says which zone", () => {
    render()
    expect(document.body.textContent).toContain("Schedule post")
    expect(timeInput().value).toBe("09:00")
    expect(q('[aria-pressed="true"]')?.getAttribute("data-date")).toBe("2026-03-02")
    expect(document.body.textContent).toContain("Mon, Mar 2, 2026")
    expect(document.body.textContent).toContain("New York time (UTC−5), from Settings.")
    // Days before today (in New York) can't be picked.
    expect(q<HTMLButtonElement>('[data-date="2026-02-28"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-date="2026-03-01"]')?.disabled).toBe(false)
  })

  it("sends the wall-clock time; the offset line follows DST", async () => {
    const { onSchedule, onClose } = render()
    await click(q<HTMLButtonElement>('[data-date="2026-03-09"]')!)
    setTime("10:30")
    expect(document.body.textContent).toContain("New York time (UTC−4), from Settings.")
    await click(byText("Schedule"))
    expect(onSchedule).toHaveBeenCalledWith("2026-03-09T10:30")
    expect(onClose).toHaveBeenCalled()
  })

  it("refuses a time the clocks skip, without sending it", async () => {
    const { onSchedule } = render()
    await click(q<HTMLButtonElement>('[data-date="2026-03-08"]')!)
    setTime("02:30")
    await click(byText("Schedule"))
    expect(onSchedule).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("That time doesn't exist in New York time")
    setTime("03:30")
    await click(byText("Schedule"))
    expect(onSchedule).toHaveBeenCalledWith("2026-03-08T03:30")
  })

  it("refuses a time that has passed", async () => {
    const { onSchedule } = render()
    await click(q<HTMLButtonElement>('[data-date="2026-03-01"]')!)
    setTime("06:59")
    await click(byText("Schedule"))
    expect(onSchedule).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("That time has passed")
  })

  it("reschedules from the current time and shows the API's refusal", async () => {
    const onSchedule = vi.fn(async () => {
      throw new Error("Only a draft can be scheduled; this post is published.")
    })
    const { onClose } = render({ publishAt: "2026-03-20T13:15:00Z", onSchedule })
    expect(timeInput().value).toBe("09:15")
    expect(q('[aria-pressed="true"]')?.getAttribute("data-date")).toBe("2026-03-20")
    await click(byText("Reschedule"))
    expect(onSchedule).toHaveBeenCalledWith("2026-03-20T09:15")
    expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("Only a draft can be scheduled")
  })

  it("can't schedule until the site's zone is known", async () => {
    const onSchedule = vi.fn(async () => {})
    act(() =>
      root.render(
        <ScheduleDialog isOpen onClose={() => {}} publishAt={null} settings={{ ...newYork, loaded: false }} onSchedule={onSchedule} now={now} />
      )
    )
    expect(document.body.textContent).toContain("Loading the site's time zone")
    expect(byText("Schedule").disabled).toBe(true)
    await click(byText("Schedule"))
    expect(onSchedule).not.toHaveBeenCalled()
  })

  it("moves through the months", async () => {
    render()
    expect(document.body.textContent).toContain("March 2026")
    expect(q<HTMLButtonElement>('[aria-label="Previous month"]')?.disabled).toBe(true)
    await click(q<HTMLButtonElement>('[aria-label="Next month"]')!)
    expect(document.body.textContent).toContain("April 2026")
    expect(q('[data-date="2026-04-30"]')).not.toBeNull()
  })
})

// Scheduling a published post's update (#335) uses the same dialog: its words say the
// live post stays as it is and that later changes aren't included.
describe("ScheduleDialog for an update", () => {
  it("says what the update is and sends the wall-clock time", async () => {
    const { onSchedule, onClose } = render({ mode: "update" })
    expect(document.body.textContent).toContain("Schedule update")
    expect(document.body.textContent).toContain("The live post stays as it is until then.")
    expect(document.body.textContent).toContain("Changes made after you schedule aren’t included; schedule again to include them.")
    await click(q<HTMLButtonElement>('[data-date="2026-03-09"]')!)
    setTime("10:30")
    await click(byText("Schedule update"))
    expect(onSchedule).toHaveBeenCalledWith("2026-03-09T10:30")
    expect(onClose).toHaveBeenCalled()
  })

  it("reschedules from the pending update's time", async () => {
    const { onSchedule } = render({ mode: "update", publishAt: "2026-03-10T14:00:00Z" })
    expect(document.body.textContent).toContain("Reschedule update")
    expect(timeInput().value).toBe("10:00")
    await click(byText("Reschedule"))
    expect(onSchedule).toHaveBeenCalledWith("2026-03-10T10:00")
  })

  it("shows the API's refusal and stays open", async () => {
    const onSchedule = vi.fn(async () => {
      throw new Error("There's nothing to update: the live post already matches this version.")
    })
    const { onClose } = render({ mode: "update", onSchedule })
    await click(byText("Schedule update"))
    expect(document.body.textContent).toContain("nothing to update")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("has no note when scheduling a draft's publish", () => {
    render()
    expect(document.body.textContent).not.toContain("aren’t included")
  })
})