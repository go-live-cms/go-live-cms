// Test helpers for the collab server tests (not a test file itself): signed tickets, an
// in-memory stand-in for the API's internal endpoints (the #280 contract), the same
// over HTTP for the process tests, and Hocuspocus client helpers.
import { createServer, type Server } from "node:http"
import { randomUUID, type KeyObject } from "node:crypto"
import type { AddressInfo } from "node:net"
import { V4 } from "paseto"
import * as Y from "yjs"
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT } from "../gl-admin/lib/collaboration/fragmentBridge"
import { TICKET_AUDIENCE, TICKET_TYPE, type DocAccess, type TicketIdentity } from "./access"
import type { CollabRecord, CollabStoreBody, CollabStoreResult, InternalApi } from "./api"

export const ISSUER = "golive.auth"

export async function ticketKeys() {
  const privateKey = (await V4.generateKey("public")) as KeyObject
  const { createPublicKey } = await import("node:crypto")
  const publicKey = createPublicKey(privateKey)
  const jwk = publicKey.export({ format: "jwk" }) as { x: string }
  const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex")
  /** A ticket shaped like token/ws_ticket.go's, with overridable claims. */
  const sign = (
    claims: Record<string, unknown> = {},
    {
      audience = TICKET_AUDIENCE,
      expiresIn = "30s",
      key = privateKey,
      now,
    }: { audience?: string; expiresIn?: string; key?: KeyObject; /** signing time (past → expired) */ now?: Date } = {},
  ) =>
    V4.sign({ user_id: "7", username: "alice", token_type: TICKET_TYPE, doc: "post-12", ...claims }, key, {
      issuer: ISSUER,
      audience,
      expiresIn,
      jti: randomUUID(),
      ...(now ? { now } : {}),
    })
  return { privateKey, publicKey, publicKeyHex, sign }
}

export interface FakePost {
  block_doc: BlockDocV1 | null
  block_revision: number
  state: string | null
  epoch: string | null
  state_revision: number | null
}

/**
 * The API side of #280, in memory: posts with block_doc/revision and stored Yjs state,
 * users with a role, and contributors owning posts. Mirrors the documented semantics:
 * GET returns the state only when it was stored at the current revision; a PUT with
 * block_doc bumps block_revision, a PUT without it stores the state only.
 */
export class FakeCollabApi implements InternalApi {
  posts = new Map<string, FakePost>()
  users = new Map<string, { role: string; owns?: string[] }>()
  puts: { postId: string; body: CollabStoreBody }[] = []
  accessCalls = 0
  failAccess = false
  failPut = false
  failGet = false

  addPost(postId: string, blockDoc: BlockDocV1 | null, revision = 1) {
    this.posts.set(postId, { block_doc: blockDoc, block_revision: revision, state: null, epoch: null, state_revision: null })
  }

  /** Something wrote block_doc around the collab server (a rollback, an import). */
  writeAround(postId: string, blockDoc: BlockDocV1) {
    const post = this.posts.get(postId)!
    post.block_doc = blockDoc
    post.block_revision += 1
  }

  async fetchAccess(identity: TicketIdentity, docName: string): Promise<DocAccess | null> {
    this.accessCalls++
    if (this.failAccess) throw new Error("access lookup failed: API responded 502")
    const user = this.users.get(identity.userId)
    if (!user) return null
    const postId = docName.slice("post-".length)
    const moderator = user.role === "admin" || user.role === "editor"
    return { role: user.role, canEdit: moderator || (user.role === "contributor" && !!user.owns?.includes(postId)) }
  }

  async getCollab(postId: string): Promise<CollabRecord | null> {
    if (this.failGet) throw new Error("collab load failed: API responded 500")
    const post = this.posts.get(postId)
    if (!post) return null
    const current = post.state !== null && post.state_revision === post.block_revision
    return {
      block_doc: post.block_doc ? structuredClone(post.block_doc) : null,
      block_revision: post.block_revision,
      ydoc_state: current ? post.state : null,
      epoch: current ? post.epoch : null,
    }
  }

  async putCollab(postId: string, body: CollabStoreBody): Promise<CollabStoreResult> {
    if (this.failPut) throw new Error("collab store failed: API responded 503")
    const post = this.posts.get(postId)
    if (!post) throw new Error("collab store failed: API responded 404")
    this.puts.push({ postId, body: structuredClone(body) })
    if (body.block_doc) {
      post.block_doc = structuredClone(body.block_doc)
      post.block_revision += 1
    }
    post.state = body.state
    post.epoch = body.epoch
    post.state_revision = post.block_revision
    return { block_revision: post.block_revision }
  }

  /** The doc as the API would hand it to a fresh server: the stored state, decoded. */
  storedDoc(postId: string): Y.Doc {
    const doc = new Y.Doc()
    const state = this.posts.get(postId)?.state
    if (state) Y.applyUpdate(doc, Buffer.from(state, "base64"))
    return doc
  }
}

/** FakeCollabApi behind real HTTP, as the API's internal listener (secret-checked). */
export async function serveFakeApi(api: FakeCollabApi, secret: string): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${secret}`) return json(401, { error: "unauthorized" })
    const url = new URL(req.url ?? "/", "http://x")
    try {
      let m = /^\/internal\/users\/(\d+)\/access$/.exec(url.pathname)
      if (m && req.method === "GET") {
        const access = await api.fetchAccess(
          { userId: m[1], issuedAt: Number(url.searchParams.get("issued_at")) },
          url.searchParams.get("doc") ?? "",
        )
        return access ? json(200, { role: access.role, can_edit: access.canEdit }) : json(404, { error: "not found" })
      }
      m = /^\/internal\/posts\/(\d+)\/collab$/.exec(url.pathname)
      if (m && req.method === "GET") {
        const record = await api.getCollab(m[1])
        return record ? json(200, record) : json(404, { error: "post not found" })
      }
      if (m && req.method === "PUT") {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        return json(200, await api.putCollab(m[1], JSON.parse(Buffer.concat(chunks).toString("utf8"))))
      }
      json(404, { error: "not found" })
    } catch (error) {
      json(502, { error: String(error) })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

export function paragraphDoc(...texts: string[]): BlockDocV1 {
  const doc: BlockDocV1 = { doc_version: 1, blocks_order: [], blocks: {} }
  texts.forEach((text, i) => {
    const id = `blk-para-${String(i + 1).padStart(6, "0")}`
    doc.blocks_order.push(id)
    doc.blocks[id] = {
      id,
      type: "paragraph",
      version: 1,
      attrs: {
        pm: {
          type: "paragraph",
          attrs: { textAlign: null, "data-block-id": id },
          content: [{ type: "text", text }],
        },
      },
    } as unknown as BlockDocV1["blocks"][string]
  })
  return doc
}

/** Appends a paragraph to a doc's editor fragment, as an editor's typing would. */
export function appendParagraph(doc: Y.Doc, text: string, id = `blk-${randomUUID()}`): string {
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph")
    fragment.insert(fragment.length, [p])
    p.setAttribute("data-block-id", id)
    p.insert(0, [new Y.XmlText(text)])
  })
  return id
}

/** The plain text of each top-level node of the editor fragment. */
export function paragraphs(doc: Y.Doc): string[] {
  return doc
    .getXmlFragment(EDITOR_FRAGMENT)
    .toArray()
    .map((node) => (node instanceof Y.XmlElement ? node.toArray().map((child) => (child instanceof Y.XmlText ? child.toString() : "")).join("") : ""))
}

export async function waitFor(check: () => boolean, { timeoutMs = 10_000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export interface Client {
  provider: HocuspocusProvider
  socket: HocuspocusProviderWebsocket
  doc: Y.Doc
  stateless: unknown[]
  /** Resolves "synced", or the permission-denied reason. */
  outcome: Promise<{ synced: true; readOnly: boolean } | { synced: false; reason: string }>
  destroy(): void
}

/** A Hocuspocus client for `docName`. `token` runs on every (re)connect, like the editor's ticket fetch. */
export function connect(url: string, docName: string, token: () => Promise<string> | string, { epoch }: { epoch?: string } = {}): Client {
  const doc = new Y.Doc()
  const stateless: unknown[] = []
  const socket = new HocuspocusProviderWebsocket({
    url: epoch ? `${url}?epoch=${encodeURIComponent(epoch)}` : url,
    // A denied client must not keep reconnecting during a test.
    maxAttempts: 1,
  })
  let settle!: (value: Awaited<Client["outcome"]>) => void
  const outcome = new Promise<Awaited<Client["outcome"]>>((resolve) => (settle = resolve))
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: docName,
    document: doc,
    token: async () => token(),
    onSynced: () => settle({ synced: true, readOnly: provider.authorizedScope === "readonly" }),
    onAuthenticationFailed: ({ reason }) => settle({ synced: false, reason }),
    onStateless: ({ payload }) => stateless.push(JSON.parse(payload)),
  })
  provider.attach()
  return {
    provider,
    socket,
    doc,
    stateless,
    outcome,
    destroy() {
      provider.destroy()
      socket.destroy()
    },
  }
}
