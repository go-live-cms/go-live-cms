# GoLive CMS — agent context (root)

A CMS written in **Go + JS** with a **real-time collaborative block editor**. Three
processes + Postgres, run via Docker Compose.

| Process | Port | Stack | Dir |
|---------|------|-------|-----|
| API | 8080 | Go, Gin, sqlc, PASETO v4 | `api/`, `db/`, `token/`, `util/` |
| WebSocket collab | 1234 | Node, y-websocket, Yjs, LevelDB | `websocket/` |
| Web | 4321 | Astro SSR + React admin SPA | `web/` |
| DB | 5432 | PostgreSQL 12 | `db/migration/` |

Scoped context lives in nested `CLAUDE.md` files — read the one for the area you're
working in: `api/`, `web/`, `web/gl-admin/lib/collaboration/`, `websocket/`.

---

## ⚠️ Preferences (do not lose these)

- **NEVER add `Co-Authored-By: Claude` (or any Claude attribution) to commits.** The
  user has stated this explicitly and repeatedly. No `🤖 Generated with` lines in
  commits either. (PR *bodies* generated via tooling are fine, but keep commits clean.)
- **Commit style:** descriptive, multi-line. Explain the *root cause* and the *fix*,
  not just what changed. Past tense, imperative subject line.
- **Commit/push only when asked.** When on a feature branch it's fine to commit there.
- Don't `git add -A` blindly — stage the specific files you changed (the user keeps
  local-only files like `websocket/.env` with debug toggles; `.env` is gitignored).

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

# Web (run from web/)
npm test                      # vitest run (headless editor/collab tests)
npm run dev                   # astro dev

# WebSocket (run from websocket/)
npm test                      # node --test

# Full stack (dev)
docker compose -f compose.dev.yaml up -d
docker compose -f compose.dev.yaml restart websocket   # e.g. to test reconnects
```

## Status / history

- Milestone 1 (MVP Alpha) is largely built; tracked in GitHub issues #184–#196, #202.
- The collaborative editor is the most sensitive subsystem and **now has test
  coverage** (added under #202 / PR #203). Read
  `web/gl-admin/lib/collaboration/CLAUDE.md` before touching it.
- **The 2026-06 collab data-loss saga is RESOLVED** (PR #204): a stack of five real
  bugs, the decisive one being a **dual yjs instance (ESM+CJS double-load) inside the
  websocket server** — `npm ls` showed one deduped copy, but the ESM `import` and
  y-websocket's CJS `require` each evaluated their own build, and cross-instance
  `Y.applyUpdate` corrupted live docs. Details + guards: `websocket/CLAUDE.md` (top
  gotcha) and `web/gl-admin/lib/collaboration/CLAUDE.md` (hard rules 0–8). `yjs` is
  pinned `13.6.31` exact in BOTH `web/` and `websocket/` — keep them in lockstep.
</content>
