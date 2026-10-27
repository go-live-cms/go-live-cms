# GoLive CMS — agent context (root)

A CMS written in **Go + JS** with a **real-time collaborative block editor**. Three
processes + Postgres, run via Docker Compose.

| Process | Port | Stack | Dir |
|---------|------|-------|-----|
| API | 8080 (+ 8081 internal, never published) | Go, Gin, sqlc, PASETO v4 | `api/`, `db/`, `token/`, `util/` |
| Collab (Hocuspocus, #206) | 1235 (+ 1236 internal) | Node, Hocuspocus, Yjs, esbuild bundle | `web/collab-server/` |
| Web | 4321 | Astro SSR + React admin SPA | `web/` |
| DB | 5432 | PostgreSQL 12 | `db/migration/` |

**Production** (`compose.yaml`, #272/#267) adds **Caddy** in front: the only published
service (80/443, TLS), `/collab` → the Hocuspocus `collab` service, everything else → web
(which forwards `/api/v1` + `/uploads`). Nothing else publishes a port. CD
(`.github/workflows/cd.yml`) pushes `ghcr.io/go-live-cms/{api,web,collab}:<sha>` and deploys
to one VM with `scripts/deploy/deploy.sh` (backup → migrate with the new image → `up
--wait`). Runbooks: `docs/operations/deploy.md`, `docs/operations/collab-cutover.md`
(the collab guards, reseeding, and the history of the y-websocket → Hocuspocus move). No
production deployment exists yet.

Scoped context lives in nested `CLAUDE.md` files — read the one for the area you're
working in: `api/`, `web/`, `web/gl-admin/lib/collaboration/`, `web/collab-server/`.

---

## ⚠️ Preferences (do not lose these)

- **NEVER add `Co-Authored-By: Claude` (or any Claude attribution) to commits.** The
  user has stated this explicitly and repeatedly. No `🤖 Generated with` lines in
  commits either. (PR *bodies* generated via tooling are fine, but keep commits clean.)
- **Commit style:** descriptive, multi-line. Explain the *root cause* and the *fix*,
  not just what changed. Past tense, imperative subject line.
- **Commit/push only when asked.** When on a feature branch it's fine to commit there.
- Don't `git add -A` blindly — stage the specific files you changed (the user keeps
  local-only files like `app.env` and a root `.env`; both are gitignored).

---

## Environment

- **Windows + PowerShell.** Use the **PowerShell** tool for shell work (the Bash tool's
  `cd`/paths often misbehave with `C:\...`). Working dir is the repo root.
- **`gh` is NOT on PATH.** Use the full path: `& "$env:ProgramFiles\GitHub CLI\gh.exe"`.
- For multi-line issue/PR bodies, write the body to a temp file with
  `[System.IO.File]::WriteAllText(...)` and pass `--body-file` — inline bodies with
  backticks/`@`/`#` break PowerShell parsing.

## Git / GitHub

- **Remote quirk:** `origin` is `https://github.com/luan-k/fiber-cms.git`, but it
  **redirects to `go-live-cms/go-live-cms`**. Pushes work via origin. **Issues, PRs,
  and project/milestone operations are done against `go-live-cms/go-live-cms`** (pass
  `--repo go-live-cms/go-live-cms`).
- **Branch naming:** `NNN-short-slug` where NNN is the issue number (e.g.
  `202-editor-test-suite-and-ws-restart-diagnosis`). Branch from the current branch
  unless told otherwise.
- **gh token scopes needed:** `repo`, `project`, `read:project` (Projects v2 work needs
  the last two; if missing, the user must run `gh auth refresh -s project,read:project`).

### GitHub Project automation (Projects v2)

Org project **"GoLive MVP"**, milestone **"MVP (Alpha): Core CMS + Collaborative Block
Editor"** (milestone passed to `gh issue create --milestone` by *title*, not number).

- Project node id: `PVT_kwDODVj0k84A_jPr`
- Project **Priority** single-select field id: `PVTSSF_lADODVj0k84A_jPrzgynp1E`
  (options: P0=`201ba0a2`, P1=`f4543b65`, P2=`0cf01fd0`)
- Native issue **Priority** field (the one shown in the issue sidebar) is set via REST:
  `PATCH repos/go-live-cms/go-live-cms/issues/N` with body
  `{"issue_field_values":[{"field_id":35551682,"value":"Urgent|High|Medium|Low"}]}`
  (value is the option *name* string, not an id).

Flow to create an issue on the board: `gh issue create --repo go-live-cms/go-live-cms
--milestone "<title>" --project "GoLive MVP" --body-file <file>`, then add to project via
`addProjectV2ItemById` GraphQL, set the project Priority field via
`updateProjectV2ItemFieldValue`, and set the native priority via the REST PATCH above.

---

## Commands

```
# Go (run from repo root)
go build ./...
go test ./...                 # or: make test
make coverage-check           # what CI runs: tests + total-coverage floor (COVERAGE_MIN)
make devseed                  # dev seed into the running stack (go run ./cmd/seed; idempotent, debug only)

# Web (run from web/)
npm test                      # vitest run (headless editor/collab tests)
npm run dev                   # astro dev

# Backups (docs/operations/backups.md). Scratch compose project, never the dev data;
# also proves migrations go up/down/up. CI job: backup-restore.
sh scripts/backup/test-restore.sh

# Full stack (dev)
docker compose -f compose.dev.yaml up -d
docker compose -f compose.dev.yaml restart collab      # e.g. to test reconnects

# Production stack locally (secrets in a gitignored .env; use another -p to keep it
# apart from real volumes). Release mode: no seeded accounts, see deploy.md step 5.
go run ./cmd/gen-prod-env -site localhost > .env
docker compose -f compose.yaml up --build -d
```

## Status / history

- Milestone 1 (MVP Alpha) is largely built; tracked in GitHub issues #184–#196, #202.
- The collaborative editor is the most sensitive subsystem and **now has test
  coverage** (added under #202 / PR #203). Read
  `web/gl-admin/lib/collaboration/CLAUDE.md` before touching it.
- **The 2026-06 collab data-loss saga is RESOLVED** (PR #204): a stack of five real
  bugs, the decisive one being a **dual yjs instance (ESM+CJS double-load) inside the
  old y-websocket server** — `npm ls` showed one deduped copy, but the ESM `import` and
  y-websocket's CJS `require` each evaluated their own build, and cross-instance
  `Y.applyUpdate` corrupted live docs. Guards today: `web/collab-server/CLAUDE.md`
  (single yjs instance) and `web/gl-admin/lib/collaboration/CLAUDE.md` (hard rules).
- **The Hocuspocus migration (#206) is complete** (P5, #285, 2026-10): `websocket/`
  (y-websocket, LevelDB, squash), the client autosave and `PUT /posts/:id/blocks` are
  gone, and there is no y-websocket rollback. Only the collab server writes
  `block_doc`. `yjs` is pinned `13.6.31` exact in `web/`, the only package that uses it.
</content>
