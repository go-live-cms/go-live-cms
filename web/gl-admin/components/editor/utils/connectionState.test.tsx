import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  OFFLINE_AFTER_MS,
  RECONNECT_GRACE_MS,
  connectionView,
  shouldWarnBeforeUnload,
  useBeforeUnloadWarning,
  useConnectionView,
  type ConnectionView,
} from "./connectionState"
import type { CollabStatus } from "./useCollabPresence"

describe("shouldWarnBeforeUnload", () => {
  it("warns while the provider has unsynced changes", () => {
    expect(shouldWarnBeforeUnload({ editable: true, unsynced: true, offline: false })).toBe(true)
  })

  it("warns while offline, even with nothing unsynced yet", () => {
    expect(shouldWarnBeforeUnload({ editable: true, unsynced: false, offline: true })).toBe(true)
  })

  it("doesn't warn once everything is synced", () => {
    expect(shouldWarnBeforeUnload({ editable: true, unsynced: false, offline: false })).toBe(false)
  })

  it("doesn't warn for a view-only editor", () => {
    expect(shouldWarnBeforeUnload({ editable: false, unsynced: true, offline: true })).toBe(false)
  })
})

describe("connectionView", () => {
  const base = { status: "disconnected" as CollabStatus, everConnected: true, droppedForMs: 0, browserOnline: true }

  it("is connecting until the first connect", () => {
    expect(connectionView({ ...base, status: "connecting", everConnected: false })).toBe("connecting")
  })

  it("shows nothing for a drop shorter than the grace period", () => {
    expect(connectionView({ ...base, droppedForMs: RECONNECT_GRACE_MS - 1 })).toBe("online")
  })

  it("is reconnecting after the grace period, offline after longer", () => {
    expect(connectionView({ ...base, droppedForMs: RECONNECT_GRACE_MS })).toBe("reconnecting")
    expect(connectionView({ ...base, droppedForMs: OFFLINE_AFTER_MS })).toBe("offline")
  })

  it("is offline at once when the browser is", () => {
    expect(connectionView({ ...base, browserOnline: false })).toBe("offline")
  })

  it("is ended, never offline, when the server refused or revoked the session", () => {
    expect(connectionView({ ...base, status: "ended", droppedForMs: OFFLINE_AFTER_MS })).toBe("ended")
    expect(connectionView({ ...base, status: "ended", everConnected: false })).toBe("ended")
  })
})

describe("useConnectionView", () => {
  let container: HTMLDivElement
  let root: Root
  let seen: ConnectionView
  function Probe({ status }: { status: CollabStatus }) {
    seen = useConnectionView(status, true)
    return null
  }
  const render = (status: CollabStatus) => act(() => root.render(<Probe status={status} />))

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
  })

  it("shows no reconnecting state for the first few seconds of a drop", async () => {
    await render("connecting")
    expect(seen).toBe("connecting")
    await render("connected")
    expect(seen).toBe("online")

    await render("connecting")
    expect(seen).toBe("online")
    await act(async () => vi.advanceTimersByTime(RECONNECT_GRACE_MS - 100))
    expect(seen).toBe("online")
    await act(async () => vi.advanceTimersByTime(100))
    expect(seen).toBe("reconnecting")
    await act(async () => vi.advanceTimersByTime(OFFLINE_AFTER_MS - RECONNECT_GRACE_MS))
    expect(seen).toBe("offline")

    await render("connected")
    expect(seen).toBe("online")
  })

  it("starts the grace period again on the next drop", async () => {
    await render("connected")
    await render("disconnected")
    await act(async () => vi.advanceTimersByTime(RECONNECT_GRACE_MS))
    expect(seen).toBe("reconnecting")
    await render("connected")
    await render("disconnected")
    expect(seen).toBe("online")
  })
})

describe("useBeforeUnloadWarning", () => {
  it("cancels beforeunload only while warning", async () => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement("div"))
    function Probe({ warn }: { warn: boolean }) {
      useBeforeUnloadWarning(warn)
      return null
    }
    const fire = () => {
      const e = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    await act(() => root.render(<Probe warn />))
    expect(fire()).toBe(true)
    await act(() => root.render(<Probe warn={false} />))
    expect(fire()).toBe(false)
    act(() => root.unmount())
  })
})
