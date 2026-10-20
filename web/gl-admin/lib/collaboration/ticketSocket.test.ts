import { afterEach, describe, expect, it, vi } from "vitest"
import { WebsocketProvider } from "y-websocket"
import { Doc as YDoc } from "yjs"
import { createTicketedWebSocket } from "./ticketSocket"

/** Minimal WebSocket double: records instances; tests drive open/close by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly OPEN = 1
  url: string
  protocols?: string | string[]
  readyState = 0
  binaryType = "blob"
  sent: unknown[] = []
  onopen: ((e: any) => void) | null = null
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  onclose: ((e: any) => void) | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ type: "close", code })
  }
  serverOpen() {
    this.readyState = 1
    this.onopen?.({ type: "open" })
  }
}

const Base = FakeWebSocket as unknown as typeof WebSocket
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  FakeWebSocket.instances = []
})

describe("createTicketedWebSocket", () => {
  it("opens the real socket with ?ticket= and forwards its events", async () => {
    const TicketedWS = createTicketedWebSocket(async () => "tkt-1", Base)
    const ws = new TicketedWS("ws://localhost:1234/post-12", "proto")
    ws.binaryType = "arraybuffer"
    const onopen = vi.fn()
    const onmessage = vi.fn()
    ws.onopen = onopen
    ws.onmessage = onmessage

    expect(ws.readyState).toBe(WebSocket.CONNECTING)
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const real = FakeWebSocket.instances[0]
    expect(real.url).toBe("ws://localhost:1234/post-12?ticket=tkt-1")
    expect(real.protocols).toBe("proto")
    expect(real.binaryType).toBe("arraybuffer")

    real.serverOpen()
    expect(onopen).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(WebSocket.OPEN)

    real.onmessage?.({ data: "x" })
    expect(onmessage).toHaveBeenCalledWith({ data: "x" })

    ws.send("hello")
    expect(real.sent).toEqual(["hello"])
  })

  it("never puts anything but the ticket in the URL", async () => {
    const TicketedWS = createTicketedWebSocket(async () => "v4.public.abc+/=", Base)
    new TicketedWS("ws://localhost:1234/post-12")
    await flush()
    const url = new URL(FakeWebSocket.instances[0].url)
    expect([...url.searchParams.keys()]).toEqual(["ticket"])
    expect(url.searchParams.get("ticket")).toBe("v4.public.abc+/=")
  })

  it("reports error + close when the ticket can't be fetched", async () => {
    const TicketedWS = createTicketedWebSocket(async () => {
      throw new Error("HTTP 403")
    }, Base)
    const ws = new TicketedWS("ws://localhost:1234/post-12")
    const onerror = vi.fn()
    const onclose = vi.fn()
    ws.onerror = onerror
    ws.onclose = onclose

    await flush()
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(onerror).toHaveBeenCalledTimes(1)
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(WebSocket.CLOSED)

    // y-websocket calls close() from inside its onclose handler; that must be a no-op.
    ws.close()
    await flush()
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it("drops a ticket that arrives after close()", async () => {
    let resolve!: (t: string) => void
    const TicketedWS = createTicketedWebSocket(() => new Promise<string>((r) => (resolve = r)), Base)
    const ws = new TicketedWS("ws://localhost:1234/post-12")
    const onclose = vi.fn()
    ws.onclose = onclose

    ws.close()
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    resolve("late")
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(onclose).toHaveBeenCalledTimes(1)
  })
})

describe("WebsocketProvider with the ticketed socket", () => {
  it("fetches a fresh ticket for every connect and reconnect", async () => {
    let n = 0
    const fetchTicket = vi.fn(async () => `tkt-${++n}`)
    const doc = new YDoc()
    const provider = new WebsocketProvider("ws://localhost:1234", "post-12", doc, {
      WebSocketPolyfill: createTicketedWebSocket(fetchTicket, Base),
      disableBc: true,
      resyncInterval: -1,
    })

    try {
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      expect(FakeWebSocket.instances[0].url).toBe("ws://localhost:1234/post-12?ticket=tkt-1")
      FakeWebSocket.instances[0].serverOpen()
      expect(provider.wsconnected).toBe(true)

      // Server restart: the socket drops, y-websocket reconnects after its backoff.
      FakeWebSocket.instances[0].close(1006)
      expect(provider.wsconnected).toBe(false)

      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
      expect(FakeWebSocket.instances[1].url).toBe("ws://localhost:1234/post-12?ticket=tkt-2")
      FakeWebSocket.instances[1].serverOpen()
      expect(provider.wsconnected).toBe(true)
      expect(fetchTicket).toHaveBeenCalledTimes(2)
    } finally {
      provider.destroy()
      doc.destroy()
    }
  })

  it("keeps retrying with new tickets while ticket requests fail", async () => {
    let calls = 0
    const fetchTicket = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error("HTTP 503")
      return "tkt-ok"
    })
    const doc = new YDoc()
    const provider = new WebsocketProvider("ws://localhost:1234", "post-12", doc, {
      WebSocketPolyfill: createTicketedWebSocket(fetchTicket, Base),
      disableBc: true,
      resyncInterval: -1,
    })
    provider.on("connection-error", () => {})

    try {
      // Backoff is 100ms then 200ms (wsUnsuccessfulReconnects 1, 2).
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { timeout: 3000 })
      expect(FakeWebSocket.instances[0].url).toBe("ws://localhost:1234/post-12?ticket=tkt-ok")
      expect(fetchTicket).toHaveBeenCalledTimes(3)
    } finally {
      provider.destroy()
      doc.destroy()
    }
  })
})
