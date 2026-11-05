// History's "Highlight changes" switch (#355), remembered for this page's lifetime only.
//
// In memory on purpose, not sessionStorage: the collab rules' rule 0 forbids any client
// cache that survives a reload, and sessionStorage does (a reload keeps it). The switch
// isn't content, but nothing of the editor's is kept on the device, so a reload resets it
// to on.

import { useSyncExternalStore } from "react"

let highlight = true
const listeners = new Set<() => void>()

export function getHighlightChanges(): boolean {
  return highlight
}

export function setHighlightChanges(on: boolean): void {
  if (highlight === on) return
  highlight = on
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The switch, shared by the History panel and the preview in the canvas. */
export function useHighlightChanges(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, getHighlightChanges, getHighlightChanges), setHighlightChanges]
}

/** Tests: back to the default. */
export function resetHighlightChanges(): void {
  setHighlightChanges(true)
}
