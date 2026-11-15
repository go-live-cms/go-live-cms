// Test helpers for the collab server tests (not a test file itself): signed tickets, an
// in-memory stand-in for the API's internal endpoints (the #280 contract), the same
// over HTTP for the process tests, and Hocuspocus client helpers.
import { createServer, type Server } from "node:http"
import { randomUUID, type KeyObject } from "node:crypto"
import type { AddressInfo } from "node:net"
import { V4 } from "paseto"
import * as Y from "yjs"
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider"
import { validateBlockDoc, type BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT } from "../gl-admin/lib/collaboration/fragmentBridge"
import { encodeCollabAuthToken, schemaFingerprint } from "../gl-admin/lib/collaboration/schemaFingerprint"
import { getInstalledCollabSchema } from "../gl-admin/lib/theme-blocks/collabSchema"
import { docKind, TICKET_AUDIENCE, TICKET_TYPE, type DocAccess, type TicketIdentity } from "./access"
import { InternalApiError, type CollabRecord, type CollabStoreBody, type CollabStoreResult, type InternalApi } from "./api"
import type { Clock } from "./recheck"

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

/** GET's answer for a stored row: the state only when it was stored at the current revision (rule 12). */
function recordOf(row: FakePost): CollabRecord {
  const current = row.state !== null && row.state_revision === row.block_revision
  return {
    block_doc: row.block_doc ? structuredClone(row.block_doc) : null,
    block_revision: row.block_revision,
    ydoc_state: current ? row.state : null,
    epoch: current ? row.epoch : null,
  }
}

/**
 * The API side of #280, in memory: posts with block_doc/revision and stored Yjs state,
 * users with a role, and contributors owning posts. Mirrors the documented semantics:
 * GET returns the state only when it was stored at the current revision; a PUT with
 * block_doc bumps block_revision, a PUT without it stores the state only.
 */
export class FakeCollabApi implements InternalApi {
  posts = new Map<string, FakePost>()
  users = new Map<string, { role: string; owns?: string[]; published?: string[] }>()
  /** user id → Unix seconds of the latest password change or reset. */
  passwordChangedAt = new Map<string, number>()
  /** Post ids in the trash (#327): the access lookup answers 410 post_trashed. */
  trashed = new Set<string>()
  /**
   * Edit access grants (#321), as `${userId}:${postId}`: a contributor who doesn't own the
   * post edits it (canEditWorkingCopy). The API applies a grant only while the post is
   * published; the fake's posts a contributor reads stand for published ones.
   */
  grants = new Set<string>()
  puts: { postId: string; body: CollabStoreBody }[] = []
  /**
   * post_block_edits (#328) as the API keeps it: post id → block id → the last edit.
   * A store with block_doc upserts its block_edits (of blocks block_doc has) and drops
   * the rows of every other block; a state-only store touches nothing.
   */
  blockEdits = new Map<string, Map<string, { user_id: number; edited_at: string }>>()
  accessCalls = 0
  failAccess = false
  failPut = false
  failGet = false

  addPost(postId: string, blockDoc: BlockDocV1 | null, revision = 1) {
    this.posts.set(postId, { block_doc: blockDoc, block_revision: revision, state: null, epoch: null, state_revision: null })
  }

  /** An admin gave the post to another member (#353, POST /posts/:id/transfer): it leaves the old owner's `owns`. */
  transferPost(postId: string, toUserId: string) {
    for (const user of this.users.values()) {
      if (user.owns) user.owns = user.owns.filter((id) => id !== postId)
    }
    const owner = this.users.get(toUserId)!
    owner.owns = [...(owner.owns ?? []), postId]
  }

  /** Something wrote block_doc around the collab server (a rollback, an import). */
  writeAround(postId: string, blockDoc: BlockDocV1) {
    const post = this.posts.get(postId)!
    post.block_doc = blockDoc
    post.block_revision += 1
  }

  /**
   * site_templates (#490): templates and parts by id, each with its kind, as
   * GET/PUT /internal/site-templates/:id/collab keep them (no block edits).
   */
  templates = new Map<string, FakePost & { kind: "template" | "part" }>()
  templatePuts: { templateId: string; body: CollabStoreBody }[] = []

  addTemplate(templateId: string, blockDoc: BlockDocV1 | null, kind: "template" | "part" = "template", revision = 1) {
    this.templates.set(templateId, { block_doc: blockDoc, block_revision: revision, state: null, epoch: null, state_revision: null, kind })
  }

  /** Something wrote a template's block_doc around the collab server (a restored backup). */
  writeAroundTemplate(templateId: string, blockDoc: BlockDocV1) {
    const template = this.templates.get(templateId)!
    template.block_doc = blockDoc
    template.block_revision += 1
  }

  async fetchAccess(identity: TicketIdentity, docName: string): Promise<DocAccess | null> {
    this.accessCalls++
    if (this.failAccess) throw new Error("access lookup failed: API responded 502")
    const user = this.users.get(identity.userId)
    if (!user) return null
    // issuedBeforePasswordChange (api/auth.go): whole seconds, strictly before → 403.
    const changedAt = this.passwordChangedAt.get(identity.userId)
    if (changedAt !== undefined && identity.issuedAt < changedAt) return null
    const ref = docKind(docName)
    if (!ref) return null
    // templateDocAccess (api/internal_handlers_read.go, #490): a missing template is a
    // 404; only an admin gets can_edit, everyone else their role with can_edit false.
    if (ref.kind === "template") {
      if (!this.templates.has(ref.id)) return null
      return { role: user.role, canEdit: user.role === "admin" }
    }
    const postId = ref.id
    // In the trash (#327): nobody, moderators included (api/internal_handlers_read.go).
    if (this.trashed.has(postId)) return { role: null, canEdit: false, trashed: true }
    const moderator = user.role === "admin" || user.role === "editor"
    // canEditPost (#135): a contributor edits only their own post, and only until it is published.
    const ownsDraft = !!user.owns?.includes(postId) && !user.published?.includes(postId)
    const granted = !user.owns?.includes(postId) && this.grants.has(`${identity.userId}:${postId}`)
    return { role: user.role, canEdit: moderator || (user.role === "contributor" && (ownsDraft || granted)) }
  }

  async getCollab(postId: string): Promise<CollabRecord | null> {
    if (this.failGet) throw new Error("collab load failed: API responded 500")
    const post = this.posts.get(postId)
    return post ? recordOf(post) : null
  }

  async getTemplateCollab(templateId: string): Promise<CollabRecord | null> {
    if (this.failGet) throw new Error("collab load failed: API responded 500")
    const template = this.templates.get(templateId)
    return template ? { ...recordOf(template), doc_kind: template.kind } : null
  }

  /**
   * PUT /internal/site-templates/:id/collab (StoreSiteTemplateCollabTx): the post rules
   * without block edits. Like the API, a block_doc must pass the template's kind (a part
   * holding a template_part is a 400), which the collab server checks before it sends one.
   */
  async putTemplateCollab(templateId: string, body: CollabStoreBody): Promise<CollabStoreResult> {
    if (this.beforePut) await this.beforePut()
    if (this.failPut) throw new Error("collab store failed: API responded 503")
    const template = this.templates.get(templateId)
    if (!template) throw new Error("collab store failed: API responded 404")
    if (!body.block_doc && body.base_revision === undefined) {
      throw new InternalApiError("collab store failed: API responded 400", 400)
    }
    if (body.base_revision !== undefined && body.base_revision !== template.block_revision) {
      throw new InternalApiError("collab store failed: API responded 409", 409)
    }
    if (body.block_edits !== undefined) throw new InternalApiError("collab store failed: API responded 400 (block_edits)", 400)
    if (body.block_doc) {
      try {
        validateBlockDoc(body.block_doc, { kind: template.kind })
      } catch {
        throw new InternalApiError("collab store failed: API responded 400", 400)
      }
    }
    this.templatePuts.push({ templateId, body: structuredClone(body) })
    if (body.block_doc) {
      template.block_doc = structuredClone(body.block_doc)
      template.block_revision += 1
    }
    template.state = body.state
    template.epoch = body.epoch
    template.state_revision = template.block_revision
    return { block_revision: template.block_revision }
  }

  /** A template's stored state, decoded, as the API would hand it to a fresh server. */
  storedTemplateDoc(templateId: string): Y.Doc {
    const doc = new Y.Doc()
    const state = this.templates.get(templateId)?.state
    if (state) Y.applyUpdate(doc, Buffer.from(state, "base64"))
    return doc
  }

  /** Awaited at the start of each PUT (to hold one in flight). */
  beforePut: (() => Promise<void>) | null = null

  async putCollab(postId: string, body: CollabStoreBody): Promise<CollabStoreResult> {
    if (this.beforePut) await this.beforePut()
    if (this.failPut) throw new Error("collab store failed: API responded 503")
    const post = this.posts.get(postId)
    if (!post) throw new Error("collab store failed: API responded 404")
    // Same rules as the API's StorePostCollabTx (#280).
    if (!body.block_doc && body.base_revision === undefined) {
      throw new InternalApiError("collab store failed: API responded 400", 400)
    }
    if (body.base_revision !== undefined && body.base_revision !== post.block_revision) {
      throw new InternalApiError("collab store failed: API responded 409", 409)
    }
    this.puts.push({ postId, body: structuredClone(body) })
    if (body.block_doc) {
      post.block_doc = structuredClone(body.block_doc)
      post.block_revision += 1
      const ids = new Set(Object.keys(body.block_doc.blocks))
      const rows = this.blockEdits.get(postId) ?? new Map()
      for (const id of [...rows.keys()]) if (!ids.has(id)) rows.delete(id)
      for (const edit of body.block_edits ?? []) {
        if (ids.has(edit.block_id)) rows.set(edit.block_id, { user_id: edit.user_id, edited_at: edit.edited_at })
      }
      this.blockEdits.set(postId, rows)
    }
    post.state = body.state
    post.epoch = body.epoch
    post.state_revision = post.block_revision
    return { block_revision: post.block_revision }
  }

  /** A post's stored attribution (#328): block id → user id. */
  editorsOf(postId: string): Record<string, number> {
    return Object.fromEntries([...(this.blockEdits.get(postId) ?? new Map()).entries()].map(([id, row]) => [id, row.user_id]))
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
        if (access?.trashed) return json(410, { error: "the post is in the trash", code: "post_trashed" })
        return access ? json(200, { role: access.role, can_edit: access.canEdit }) : json(404, { error: "not found" })
      }
      m = /^\/internal\/site-templates\/(\d+)\/collab$/.exec(url.pathname)
      if (m && req.method === "GET") {
        const record = await api.getTemplateCollab(m[1])
        return record ? json(200, record) : json(404, { error: "template not found" })
      }
      if (m && req.method === "PUT") {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        return json(200, await api.putTemplateCollab(m[1], JSON.parse(Buffer.concat(chunks).toString("utf8"))))
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

/**
 * A manual clock for the access re-check: timers fire only in dvance, which awaits
 * each callback (the re-check's lookup) before the next one.
 */
export class FakeClock implements Clock {
  private time = 0
  private seq = 0
  private timers = new Map<number, { at: number; callback: () => unknown }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => unknown, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  /** Moves the clock forward ms, running every timer that comes due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      let next: [number, { at: number; callback: () => unknown }] | undefined
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      if (!next) break
      this.timers.delete(next[0])
      this.time = Math.max(this.time, next[1].at)
      await next[1].callback()
    }
    this.time = end
  }
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
  /** Reasons of the close messages (and socket closes) this provider saw. */
  closes: string[]
  /** Resolves "synced", or the permission-denied reason. */
  outcome: Promise<{ synced: true; readOnly: boolean } | { synced: false; reason: string }>
  destroy(): void
}

/**
 * The fingerprint of the schema a server converts with by default (the installed collab
 * schema, #416): what an editor built from this commit sends.
 */
export const SCHEMA_FINGERPRINT = schemaFingerprint(getInstalledCollabSchema())

/**
 * A Hocuspocus client for `docName`. `token` runs on every (re)connect, like the editor's
 * ticket fetch; the ticket goes out with `schema` (default `SCHEMA_FINGERPRINT`), or bare
 * when `schema` is null, as a client from before #416 sends it.
 */
export function connect(
  url: string,
  docName: string,
  token: () => Promise<string> | string,
  { epoch, schema = SCHEMA_FINGERPRINT }: { epoch?: string; schema?: string | null } = {},
): Client {
  const doc = new Y.Doc()
  const stateless: unknown[] = []
  const closes: string[] = []
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
    token: async () => {
      const ticket = await token()
      return schema === null ? ticket : encodeCollabAuthToken(ticket, schema)
    },
    onSynced: () => settle({ synced: true, readOnly: provider.authorizedScope === "readonly" }),
    onAuthenticationFailed: ({ reason }) => settle({ synced: false, reason }),
    onStateless: ({ payload }) => stateless.push(JSON.parse(payload)),
    onClose: ({ event }) => closes.push(String(event.reason ?? "")),
  })
  provider.attach()
  return {
    provider,
    socket,
    doc,
    stateless,
    closes,
    outcome,
    destroy() {
      provider.destroy()
      socket.destroy()
    },
  }
}
