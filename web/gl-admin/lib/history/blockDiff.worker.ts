/// <reference lib="webworker" />
// The History diff worker (#355): compares two Block Spec docs off the main thread, so a
// 2,000-block post doesn't freeze the editor. Vite bundles it as its own file (the
// `new Worker(new URL(...), import.meta.url)` in diffClient.ts), served same-origin, which
// the admin CSP's `worker-src 'self'` allows (#161). It only reads the two docs it is sent:
// it never sees the live editor or the Yjs document.

import { handleDiffRequest, type DiffRequest } from "./diffProtocol"

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<DiffRequest>) => {
  scope.postMessage(handleDiffRequest(event.data))
}
