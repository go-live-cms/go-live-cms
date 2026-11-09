import { apiCall } from "../api"
import { ApiError } from "./errors"
import type { EmbedProvider } from "@gl-admin/lib/blocks-spec"

// POST /embeds/resolve (#425, editors and admins): which allowed provider a pasted link
// belongs to, the item's id and its title ("" when the provider gave none).

export interface ResolvedEmbed {
  provider: EmbedProvider
  ref: string
  title: string
}

export const EMBED_NOT_ALLOWED = "embed_not_allowed"

export async function resolveEmbed(url: string): Promise<ResolvedEmbed> {
  return (await apiCall("/embeds/resolve", { method: "POST", body: JSON.stringify({ url }) })) as ResolvedEmbed
}

export function isEmbedNotAllowed(error: unknown): boolean {
  return error instanceof ApiError && error.code === EMBED_NOT_ALLOWED
}
