import { createContext } from "react"
import type { PostBlockEditsStore } from "@gl-admin/lib/blockEditsStore"

/**
 * The open post's per-block "Last edited by" (#328), for the block menu. Provided by
 * the bound editor (Editor.tsx); null elsewhere (a new post, the static read-only view),
 * where the menu shows no line.
 */
export const BlockEditsContext = createContext<PostBlockEditsStore | null>(null)
