// A WebSocket stand-in that fetches a fresh collab ticket before every connection (#233).
//
// The collab socket can't send an Authorization header, so its credential rides in the
// URL, and proxy/load-balancer access logs record that URL. It therefore carries a
// single-use, 30s, doc-bound ticket from POST /collab/tickets instead of the access
// token. A ticket only works once, so every connect AND every reconnect needs a new one.
//
// y-websocket constructs its socket synchronously (`new provider._WS(provider.url)`) on
// connect and on each backoff reconnect, so the hook is its `WebSocketPolyfill` option:
// this class is returned synchronously, fetches the ticket, then opens the real socket
// and forwards its events. If the ticket fetch fails it reports error + close, and
// y-websocket schedules its usual backoff reconnect (which fetches a new ticket).

type Listener<E> = ((event: E) => void) | null

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

export function createTicketedWebSocket(
  fetchTicket: () => Promise<string>,
  BaseWebSocket: typeof WebSocket = WebSocket,
): typeof WebSocket {
  class TicketedWebSocket {
    static readonly CONNECTING = CONNECTING
    static readonly OPEN = OPEN
    static readonly CLOSING = CLOSING
    static readonly CLOSED = CLOSED
    readonly CONNECTING = CONNECTING
    readonly OPEN = OPEN
    readonly CLOSING = CLOSING
    readonly CLOSED = CLOSED

    binaryType: BinaryType = "blob"
    onopen: Listener<Event> = null
    onmessage: Listener<MessageEvent> = null
    onerror: Listener<Event> = null
    onclose: Listener<CloseEvent> = null

    private socket: WebSocket | null = null
    // readyState while no real socket exists yet (ticket pending, failed or cancelled).
    private pendingState = CONNECTING

    constructor(url: string | URL, protocols?: string | string[]) {
      fetchTicket().then(
        (ticket) => {
          if (this.pendingState !== CONNECTING) return // closed while the ticket was in flight
          const target = new URL(String(url))
          target.searchParams.set("ticket", ticket)
          const socket = new BaseWebSocket(target.toString(), protocols)
          socket.binaryType = this.binaryType
          socket.onopen = (e) => this.onopen?.(e)
          socket.onmessage = (e) => this.onmessage?.(e)
          socket.onerror = (e) => this.onerror?.(e)
          socket.onclose = (e) => this.onclose?.(e)
          this.socket = socket
        },
        (err) => {
          if (this.pendingState !== CONNECTING) return
          this.pendingState = CLOSED
          const reason = err instanceof Error ? err.message : String(err)
          this.onerror?.({ type: "error", message: `collab ticket request failed: ${reason}` } as unknown as Event)
          this.onclose?.({ type: "close", code: 4401, reason: "collab ticket unavailable", wasClean: false } as CloseEvent)
        },
      )
    }

    get readyState(): number {
      return this.socket ? this.socket.readyState : this.pendingState
    }

    get url(): string {
      return this.socket?.url ?? ""
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (!this.socket) throw new Error("collab socket is not open yet")
      this.socket.send(data)
    }

    close(code?: number, reason?: string) {
      if (this.socket) {
        this.socket.close(code, reason)
        return
      }
      if (this.pendingState !== CONNECTING) return
      // Closed before the real socket existed: drop the ticket when it arrives and
      // report the close asynchronously, like a real socket closed while connecting.
      this.pendingState = CLOSED
      setTimeout(() => {
        this.onclose?.({ type: "close", code: code ?? 1000, reason: reason ?? "", wasClean: false } as CloseEvent)
      }, 0)
    }
  }

  return TicketedWebSocket as unknown as typeof WebSocket
}
