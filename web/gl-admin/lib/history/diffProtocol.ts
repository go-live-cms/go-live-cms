// The messages between diffClient.ts and blockDiff.worker.ts (#355). Kept apart from the
// worker entry so tests can run the handler without a Worker.

import type { BlockDocV1 } from "../blocks-spec"
import { diffBlockDocs, type BlockDocDiff } from "./blockDiff"

export interface DiffRequest {
  id: number
  version: BlockDocV1 | null
  working: BlockDocV1 | null
}

export type DiffResponse = { id: number; diff: BlockDocDiff } | { id: number; error: string }

export function handleDiffRequest(request: DiffRequest): DiffResponse {
  try {
    return { id: request.id, diff: diffBlockDocs(request.version, request.working) }
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) }
  }
}
