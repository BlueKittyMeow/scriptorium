# Scriptorium
### A preservation-first writing application
### Design Document v0.7

---

## Vision

Kyla opens a webpage on any device — phone, old laptop, library computer — and her entire library is there. She writes. She organizes. She doesn't think about backups, versioning, or sync. She can't accidentally destroy anything.

Meanwhile, Lara sees the archival layer: every version of every document, immutable snapshots, backup status, cross-novel metadata. The archivist works quietly behind the writer.

**Design philosophy:** The writer's interface should feel like a clean notebook. The archivist's interface should feel like a card catalog.

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│         Kyla's Devices              │
│  (phone, laptop, any browser)       │
│         ↕ HTTPS only                │
├─────────────────────────────────────┤
│       Scriptorium Server            │
│  (Lara's desktop / Pi / VPS)        │
│                                     │
│  ┌───────────┐  ┌───────────────┐   │
│  │ SvelteKit  │  │   SQLite DB   │   │
│  │ +server.js │  │  (metadata,   │   │
│  │  endpoints │  │   versions,   │   │
│  │  + Auth    │  │   tree, links) │   │
│  └───────────┘  └───────────────┘   │
│        │                            │
│  ┌─────────────────────────────┐    │
│  │   Content Store (files)     │    │
│  │   /data/novels/             │    │
│  │   /data/snapshots/          │    │
│  │   /data/trash/              │    │
│  └─────────────────────────────┘    │
│        │                            │
│  ┌─────────────────────────────┐    │
│  │  Backup Service (cron)      │    │
│  │  → Google Drive via rclone  │    │
│  │  → git commits (optional)   │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

**Key principle:** Kyla's devices cache the full working set locally — binder tree, all documents in the active novel, recent edits. Writing is always lag-free, always works offline. The app syncs diffs to the server when connectivity exists. She should never feel a network request, and she should be able to write for hours in rural Maine with no signal and sync when she drives into town. The server remains the canonical source of truth; the local cache is a working copy.

---

## Image Support

### Storage
- Originals stored on server: `/data/{novel-uuid}/images/{uuid}.{ext}`
- Proxies auto-generated on upload via **sharp** (fast, low memory, Node.js native) at three breakpoints:
  - Thumbnail: 150px (for binder/card views)
  - Medium: 400px (for inline display on mobile)
  - Large: 800px (for inline display on desktop)
- Original preserved for archival/export
- **Note:** sharp has native dependencies — verify builds on target deployment platform (especially Pi/ARM)

### Serving Strategy
- Device queries server for image; server selects proxy based on:
  - **Device viewport** (phone gets medium, desktop gets large)
  - **Network quality** (slow connection gets thumbnail with tap-to-load)
  - **User preference** (settings: "low bandwidth mode" forces thumbnails everywhere)
- Images cached aggressively on client (long cache headers, service worker)
- Offline: whatever's been cached is available; uncached images show placeholder

### Use Cases
- Character portraits/reference images
- Maps (world maps, city layouts, floor plans)
- Mood boards / visual reference
- Cover concepts
- Research images (historical reference, etc.)

### Storage Estimates
- Text-only: ~75MB/month of snapshots at heavy use
- With images: depends heavily on usage. Budget 500MB-1GB/month if image-heavy.
- Proxies add ~30% overhead on top of originals (3 sizes)
- Still very manageable: a year of heavy use with images < 15GB
- **Archivist dashboard should surface:** total snapshot storage, growth rate, largest novels by storage

---

## Data Model

### Core Entities

**Library** — top-level container (one per user, but could support multiple)

**World** — a fictional universe grouping novels together (Phase 4; in Phase 1, novels exist at library root)
- name, description, notes
- e.g., "The Silvers Universe", "Antarctica", "Standalone"

**Novel** — a writing project
- title, subtitle, status (draft/revision/complete/abandoned)
- belongs to one or more Worlds **(many-to-many via novel_worlds join table)**
- word count target (optional)
- compile settings
- server_version (integer, for sync — see Sync Protocol)
- created_at, updated_at

**Folder** — organizational container within a novel
- title, position in tree
- can nest (chapters containing scenes, acts containing chapters, etc.)
- types: Manuscript, Research, Notes, Characters, Trash (per-novel)
- server_version (integer, for sync)
- created_at, updated_at

**Document** — the atomic unit of writing
- title, content (HTML from TipTap), synopsis, notes
- position in tree (under a Folder or directly under Novel)
- status labels (draft, revised, final, etc.)
- word count (computed)
- compile_include (boolean, default true — for export include/exclude; compile API can override with explicit include_ids list)
- server_version (integer, for sync)
- created_at, updated_at

**Snapshot** — immutable versioned copy of a Document
- document_id, content, word_count, created_at
- auto-created on save (debounced: not more than 1 per 2 minutes)
- NEVER deleted except by Archivist with explicit confirmation
- reason: "autosave" | "manual" | "pre-restructure" | "pre-sync-conflict"

**Character** — cross-novel entity
- name, aliases, description, notes
- linked to one or more Worlds
- can be tagged in Documents

**Link** — connections between entities
- character ↔ novel (appears_in)
- character ↔ character (relationship: ally, enemy, family, etc.)
- novel ↔ novel (sequel, prequel, same_world, references)
- document ↔ document (cross-reference)
- document ↔ character (features, mentions)

### Schema Notes
- Novel ↔ World is **many-to-many** (a novel can belong to multiple worlds; a world contains multiple novels). Implemented via `novel_worlds` join table.
- All entities carry a `deleted_at` nullable timestamp for soft-delete.
- All tree positions use a `sort_order` float for easy reordering without rewriting siblings. Periodic renormalization (rewrite siblings to evenly-spaced integers) needed after many insertions to avoid float precision exhaustion.
- Full-text search index (SQLite FTS5) on: document title, document content, character name, character description, novel title.

### Example: Kyla's Library

```
Library: Kyla
├── World: The Silvers Universe
│   ├── Novel: Tigrenache
│   │   ├── Manuscript/
│   │   │   ├── Chapter 1: [document]
│   │   │   └── Chapter 2: [document]
│   │   ├── Characters/
│   │   │   ├── Talamus [→ Character entity]
│   │   │   └── Ress [→ Character entity, linked to OHMA?]
│   │   ├── Research/
│   │   └── Trash/ (novel-level, soft-delete only)
│   │
│   ├── Novel: Tumult and Tempest
│   │   └── ... (The Commander, His Lordship, etc.)
│   │
│   ├── Novel: Rebellion and Revival
│   ├── Novel: Coven at Devil's Den
│   │
│   └── Shared Characters:
│       ├── Ress (Tigrenache era → possibly OHMA in T&T era)
│       ├── The Commander
│       ├── His Lordship
│       └── ...
│
├── World: Antarctica
│   └── Novel: The Importance of Being Ernest Shackleton
│
└── World: Standalone
    ├── Novel: WuilfGirl
    └── Novel: Benny and Max
```

---

## Roles & Permissions

### Writer (Kyla)
- Create, edit, organize novels/folders/documents
- Soft-delete (moves to per-novel Trash folder)
- Browse own snapshot history ("Show me Tuesday's version")
- Create/edit characters and cross-novel links
- Compile/export
- Search across library
- **CANNOT**: permanently delete anything, access admin panel, modify backup settings

### Archivist (Lara)
- Everything Writer can do, PLUS:
- Permanently empty trash (with confirmation + cooldown)
- Restore from trash
- View all snapshots across all documents
- Import .scriv projects
- Manage backup configuration
- View backup status/health
- View storage metrics (snapshot growth, disk usage)
- Access audit log (who changed what, when)
- Manage user accounts

### Protection Rules
- No bulk delete operations exist in the UI at all
- Single document soft-delete requires confirmation
- Trash auto-empties: NEVER (only Archivist manual action)
- Moving a folder to trash moves all children — but they're individually restorable
- Renaming is non-destructive (old name recorded in snapshot)

---

## Technical Stack

### Backend
- **Runtime:** Node.js (v22)
- **Framework:** SvelteKit (`+server.js` API endpoints) — single process, no CORS, built-in adapter-node for deployment. Express deferred unless auth/sync complexity demands it later (see Decisions Made).
- **Database:** SQLite via better-sqlite3 (metadata, tree structure, versions, links, FTS5 search). DB initialized in `hooks.server.js`, passed via `event.locals`.
- **Image processing:** sharp (proxy generation, Phase 4+)
- **Content storage:** Files on disk (HTML, one per document) — the **file is the source of truth** for content
  - Human-readable, greppable, git-friendly
  - Path: `/data/{novel-uuid}/docs/{doc-uuid}.html`
  - SQLite stores metadata (title, word count, timestamps, tree position) — NOT the full content
  - FTS5 index mirrors document text for search (updated on save alongside the file)
  - **Atomic write strategy:** write to `{doc-uuid}.html.tmp` → `fsync` → `rename` to final path (atomic on same filesystem) → update SQLite in transaction. If SQLite update fails, file is orphaned but content is safe. Startup consistency check reconciles.
- **Snapshot storage:** `/data/{novel-uuid}/snapshots/{doc-uuid}/{timestamp}.html`
- **Data root:** Configurable via `DATA_ROOT` env variable (default: `./data`). Essential for local setup on any machine.
- **Auth (Phase 2+):** bcrypt + SvelteKit hooks for session management
  - Stretch: passkeys/WebAuthn for passwordless
- **Backup (Phase 3+):** rclone to Google Drive on cron (server-side only — Kyla never touches this)

### Frontend
- **Framework:** SvelteKit
  - Compiles away — no runtime framework shipped to client
  - Minimal bundle size for old/underpowered devices
  - Built-in service worker support
  - File-based routing
- **Editor:** TipTap (ProseMirror-based)
  - Svelte integration via `svelte-tiptap` (community-maintained — verify maturity before committing; fallback: use TipTap core directly with Svelte wrapper)
  - Rich text: bold, italic, headers, block quotes, lists
  - Inline notes/comments (for writer's annotations)
  - Word count (live)
  - Focus mode (dim everything except current paragraph)
  - Markdown shortcuts (type `# ` to get a heading, etc.)
- **Tree/Binder:** Sidebar with drag-and-drop reordering
  - svelte-dnd-action or similar
- **Responsive:** Must work on phone screens
  - Sidebar collapses to hamburger menu on mobile
  - Editor fills screen
  - Phone experience = "open app, tap document, write"
- **Offline:** Full working set cached locally (see Sync Protocol below)
  - Service worker + IndexedDB for local state
  - Clear visual indicator: "Saved ✓" / "Saving..." / "Offline — changes saved locally"
  - Queued changes sync automatically when connectivity returns
  - **Session expiry during offline:** save queue persists independently of auth state. On reconnect, if session is expired, client prompts re-auth THEN flushes queue. Queued work is NEVER dropped due to auth failure.

### Deployment
- **MVP–Phase 2:** `localhost:5173` (SvelteKit dev) or built with `adapter-node` on Lara's machine
- **Phase 3:** Cloudflare Tunnel for external access (free, encrypted)
  - `scriptorium.yourdomain.com` or similar
  - Alternative: Tailscale for family-only access
- **Stretch:** Docker container for easy deployment to VPS/Pi
  - Single `docker-compose up` to run everything
  - SQLite file + content directory = entire state (easy backup)
  - **Pi deployment note:** verify sharp ARM builds (Phase 4+); consider minimum Pi 3B+ or better

---

## Sync Protocol

This is the most architecturally significant component. The goal: Kyla writes offline with zero friction, changes sync seamlessly when connectivity exists, and no work is ever lost.

### State Tracking

Each entity (document, folder, novel) carries:
- `server_version`: integer, incremented on every server-side write
- `updated_at`: timestamp of last modification

The client maintains in IndexedDB:
- `last_sync_version`: per-entity, the server_version at last successful sync
- `local_changes`: queue of operations performed offline
- `last_sync_timestamp`: global, when the client last talked to the server

### Operation Types

The full set of sync-able operations:
- `novel_create`, `novel_update`
- `folder_create`, `folder_update`
- `document_create`, `document_update`
- `tree_move` (reparent or reorder any node)
- `tree_delete` (soft-delete any node)

### Sync Payload (Examples)

```
POST /api/sync
{
  last_sync_timestamp: "2026-02-19T21:00:00Z",
  changes: [
    {
      type: "document_update",
      entity_id: "doc-uuid-123",
      base_version: 5,           // server_version client started from
      content: "<p>...</p>",
      updated_at: "2026-02-19T21:15:00Z"
    },
    {
      type: "tree_move",
      entity_id: "doc-uuid-456",
      base_version: 3,
      old_parent_id: "folder-uuid-111",   // for rollback if move rejected
      old_sort_order: 1.0,
      new_parent_id: "folder-uuid-789",
      new_sort_order: 2.5,
      updated_at: "2026-02-19T21:10:00Z"
    },
    {
      type: "document_create",
      temp_id: "local-temp-1",    // client-assigned, server replaces with real ID
      parent_id: "folder-uuid-789",
      title: "New Scene",
      content: "<p>...</p>",
      sort_order: 3.0
    },
    {
      type: "tree_delete",        // soft-delete
      entity_id: "doc-uuid-999",
      base_version: 2
    }
  ]
}
```

### Server Response

```
{
  sync_timestamp: "2026-02-19T22:00:00Z",
  results: [
    { temp_id: "local-temp-1", server_id: "doc-uuid-new", version: 1, status: "created" },
    { entity_id: "doc-uuid-123", version: 6, status: "accepted" },
    { entity_id: "doc-uuid-456", version: 4, status: "accepted" },
    { entity_id: "doc-uuid-999", version: 3, status: "accepted" }
  ],
  server_changes: [
    // Changes made server-side since client's last_sync_timestamp
    // that the client doesn't know about yet
    { entity_id: "doc-uuid-789", type: "document_update", version: 8, content: "...", ... }
  ],
  conflicts: [
    // Only if base_version doesn't match current server_version
    {
      entity_id: "doc-uuid-123",
      type: "content_conflict",
      client_accepted: true,
      server_snapshot_id: "snap-uuid-abc",   // preserved for safety
      message: "Server had version 7; your changes applied as version 8. Server state preserved as snapshot."
    }
  ]
}
```

### Conflict Resolution

#### Document Content Conflicts
When `base_version` doesn't match server's current version:
1. **Client WINS** (freshest human intent)
2. Server's current state is saved as a snapshot with reason `"pre-sync-conflict"`
3. Client version becomes the new server state
4. Conflict is logged in audit trail
5. No user-facing merge UI needed — the snapshot preserves the server state for Archivist review

#### Tree Conflicts (structural changes)
Tree conflicts are harder than content conflicts. Strategy:

1. **Moves/reorders:** Last-write-wins by timestamp. If client moved doc A to folder X at 9:15pm, and server moved doc A to folder Y at 9:10pm, client wins (more recent). Server's tree state before applying is snapshotted. **Clock skew note:** for a two-user system, minor skew is acceptable. If skew becomes a problem, fall back to server-receive ordering.

2. **Concurrent creation:** Both creations are accepted. If they'd occupy the same sort_order, server adjusts the later one's sort_order to avoid collision. **Server MUST return adjusted sort_order** in the sync response so the client updates its local state.

3. **Move to deleted parent:** If client moves a doc into a folder that was deleted server-side, the move is rejected and the doc stays in its pre-move location. Client is notified: "Folder X was deleted — your document stayed in its original location." **Note:** `tree_move` payload includes `old_parent_id` + `old_sort_order` so the server can deterministically place the doc back, even if the pre-move parent was also moved or deleted. Server response includes `current_parent_id` + `current_sort_order` for rejected moves.

4. **Delete of moved child:** If client deletes a doc that was moved server-side to a new location, the soft-delete still applies (just at its new location). No conflict.

5. **Move of deleted child:** If client moves a doc that was soft-deleted server-side, the **delete wins** — the doc remains deleted. Client is notified: "Document was deleted — move not applied."

6. **Cyclic move detection:** Server MUST validate that `new_parent_id` is not a descendant of the node being moved. If Client A moves Folder X into Folder Y while Client B moves Folder Y into Folder X, accepting both creates an unresolvable cycle (nodes vanish from the tree). The server rejects the move that would create a cycle; the earlier move stands.

7. **Structural snapshot:** On any tree conflict, the server saves a full tree-state snapshot (JSON of the entire binder structure) for Archivist review.

#### Sync Batch Processing Order
Operations within a single sync payload are processed in deterministic order:
1. **Creates** (novels, folders, documents) — so new entities exist before being referenced
2. **Updates** (content, metadata) — applied to existing + newly created entities
3. **Moves** (reparent, reorder) — after entities exist and are updated
4. **Deletes** (soft-delete) — last, so moves into a to-be-deleted parent are caught

If any operation fails, subsequent dependent operations are skipped. Server returns per-operation status so the client knows exactly what succeeded.

#### Client-Side Optimizations
- **Coalesce offline updates:** If a document is edited 10 times offline, only the final state needs to sync (not 10 intermediate versions). Client coalesces `document_update` operations per entity before sending.
- **sort_order feedback:** When renormalization occurs server-side, affected sort_order values are returned in the sync response so clients update their local state.

### Online Behavior
When online, the client syncs in near-real-time:
- Document saves trigger sync after a short debounce (2-3 seconds)
- Tree operations sync immediately
- Server pushes updates via SSE (Server-Sent Events) or polling (every 30 seconds)
- Client applies server changes to local cache automatically

### Offline → Online Transition
1. Connectivity detected (navigator.onLine + fetch probe to server)
2. Client sends full sync payload with all queued changes
3. Server processes changes, returns results + any server-side changes
4. Client updates local cache with server response
5. Status indicator: "Syncing..." → "Synced ✓"
6. If auth expired: prompt re-login, hold queue, flush after re-auth

---

## .scriv Import

**MVP feature** — this is the primary ingest path for existing manuscripts. Basic import (text + structure) is MVP; rich RTF features (embedded images, footnotes, annotations) iterate in Phase 1.

Scrivener projects are directories containing:
```
MyNovel.scriv/
├── MyNovel.scrivx          (XML: binder tree structure)
├── Files/
│   ├── Data/
│   │   ├── {UUID}/
│   │   │   ├── content.rtf (the actual text)
│   │   │   ├── synopsis.txt
│   │   │   └── notes.rtf
│   └── ...
├── Snapshots/
│   └── {UUID}/
│       └── {timestamp}.rtf
└── Settings/
```

**Import process:**
1. Parse .scrivx XML → extract binder tree (folders, documents, ordering)
2. For each document: convert RTF → HTML via `@iarna/rtf-to-html` **(validated)**
   - **Tested against real .scriv project:** 14/14 RTF files converted, zero errors. Curly quotes, em dashes, bold, font changes all preserved. Tables flattened to paragraphs (acceptable — decorative layout, not content). See rtf-test/ for test harness.
   - **Known limitations:** Embedded images in RTF not extracted (Phase 1 iteration). Footnotes/annotations may not map cleanly.
3. Rebuild tree in Scriptorium's data model
4. Import snapshots if present (Phase 1 — not all .scriv projects have them)
5. Map Scrivener labels/status to Scriptorium equivalents
6. Preserve Scrivener binder IDs as import metadata (for re-import/comparison)
7. **Import validation report:** Display counts (docs imported, folders created, files skipped, conversion errors) so user can trust the result

**Library:** `@iarna/rtf-to-html` (confirmed). XML parsing via `fast-xml-parser`.

---

## Versioning Strategy

### Automatic Snapshots
- **Trigger:** Document save (debounced: max 1 snapshot per 2 minutes of active editing)
- **Also trigger on:** document move, rename, any structural change, pre-sync-conflict
- **Storage:** Full content copy (not diffs — simpler, disk is cheap)
- **Retention:** Forever by default (only Archivist can prune, and even then with warnings)
- **Monitoring:** Archivist dashboard surfaces total snapshot count, storage used, growth rate. At current estimates (~75MB/month text-only), multi-year retention is sustainable but should be tracked.

### Snapshot Browsing (Writer)
- Timeline view: "3 hours ago — 2,847 words" / "Yesterday — 2,612 words"
- Side-by-side diff view (optional, stretch goal)
- "Restore this version" creates a NEW snapshot of current state, THEN reverts
  - So restoration is itself non-destructive

### Offline Cache Strategy
- **Always cached:** Full binder tree for entire library (metadata only — tiny)
- **Cached on open:** Any document Kyla opens gets cached locally and STAYS cached
- **Optional offload:** A "free up space" toggle in settings lets her push local copies to server-only and remove them from device cache
- **Cache budget:** Configurable max local storage (default: 100MB, adjustable down for old phones)
- **Indicator:** Library view shows which documents are available offline (subtle icon)

### Backup Cadence (Server-side)
- rclone sync to Google Drive: every 15 minutes (configurable)
- git commit of content directory: daily (configurable)
- Health check: dashboard shows last successful backup time
  - Warning if > 1 hour since last backup
  - Alert if > 24 hours

---

## API Routes (Draft)

### Auth
- POST /auth/login
- POST /auth/logout
- GET  /auth/me

### Sync
- POST /api/sync (primary sync endpoint — see Sync Protocol above)
- GET  /api/sync/changes?since={timestamp} (poll for server-side changes)
- GET  /api/sync/status (connection health, last sync time)

### Library
- GET  /api/novels
- POST /api/novels
- GET  /api/novels/:id
- PUT  /api/novels/:id
- DELETE /api/novels/:id (soft-delete only)

### Search
- GET  /api/search?q={query} (full-text across library via FTS5)
- GET  /api/search?q={query}&novel={id} (scoped to novel)

### Tree / Binder
- GET  /api/novels/:id/tree
- POST /api/novels/:id/tree/nodes (create folder or document)
- PUT  /api/novels/:id/tree/reorder (move/reorder nodes)
- DELETE /api/novels/:id/tree/nodes/:nodeId (soft-delete)

### Documents
- GET  /api/documents/:id
- PUT  /api/documents/:id (save content — triggers snapshot)
- GET  /api/documents/:id/snapshots
- GET  /api/documents/:id/snapshots/:snapshotId
- POST /api/documents/:id/snapshots (manual "save point")
- POST /api/documents/:id/restore/:snapshotId

### Compile/Export
- POST /api/novels/:id/compile (generate export — returns binary download)
  - Body: `{ format: "docx"|"epub"|"pdf"|"markdown", configId?: "..." }`
  - Returns: binary file with Content-Disposition attachment header
  - Pipeline: tree-walk → assemble HTML (title page + chapters) → Pandoc stdin/stdout
  - PDF engine: wkhtmltopdf (no LaTeX dependency)
- GET  /api/novels/:id/compile/preview (HTML preview — no Pandoc needed)
  - Returns: text/html with CSP header blocking scripts
  - Query: `?configId=...` to use saved config's include_ids
- GET  /api/novels/:id/compile/configs (list saved compile configurations)
- POST /api/novels/:id/compile/configs (create new configuration)
  - Body: `{ name, format, include_ids?: string[] }`
- PUT  /api/novels/:id/compile/configs/:configId (update configuration)
- DELETE /api/novels/:id/compile/configs/:configId (delete configuration)
- PATCH /api/novels/:id/tree/nodes/:nodeId (compile_include toggle)
  - Body: `{ compile_include: true|false }`

### Characters & Links (Phase 4)
- CRUD for characters
- CRUD for worlds
- POST /api/links (create link between any two entities)
- GET  /api/characters/:id/appearances (all novels/docs featuring)
- GET  /api/worlds/:id/graph (visualization data)

### Admin (Archivist only)
- GET  /api/admin/trash
- POST /api/admin/trash/:id/restore
- DELETE /api/admin/trash/:id/purge (permanent, with confirmation token)
- GET  /api/admin/backups (status, last run, health)
- GET  /api/admin/storage (snapshot counts, disk usage, growth trends)
- POST /api/admin/import/scriv (upload .scriv directory)
- GET  /api/admin/audit-log

---

## Phase Plan

### MVP: The Local Scriptorium 📜 ✅
*Goal: Ingest .scriv files, browse and edit locally, search everything*

No auth, no sync, no offline cache — single-process SvelteKit on `localhost:5173`.

**Core:**
- [x] Project scaffolding (SvelteKit with `+server.js` API endpoints, adapter-node)
- [x] SQLite schema for novels, folders, documents, snapshots (DB via `hooks.server.js` + `event.locals`)
- [x] FTS5 search index (content mirrored from files into SQLite for search)
- [x] File-based content storage with atomic writes (tmp → rename → SQLite transaction)
- [x] `DATA_ROOT` env variable for configurable data directory
- [x] .scriv import (parse .scrivx via fast-xml-parser, RTF → HTML via @iarna/rtf-to-html, rebuild tree)
- [x] Import validation report (docs imported, folders created, skipped files, errors)
- [x] TipTap editor with basic rich text (thin custom wrapper — svelte-tiptap skipped, TipTap core used directly)
- [x] Sidebar binder tree with drag-and-drop
- [x] Auto-save with snapshot creation
- [x] New novel / new document / new folder
- [x] Soft-delete to trash
- [x] Basic full-text search
- [x] Basic responsive layout (works on phone)

### Phase 1a: Snapshot Browser ✅
*Pulled forward from Phase 1 — "Show me Tuesday's version"*

- [x] Snapshot timeline panel with day grouping, word count deltas, reason labels
- [x] Read-only snapshot preview (TipTap in non-editable mode)
- [x] Non-destructive restore (pre-restore snapshot created automatically)
- [x] Manual snapshot creation from editor footer
- [x] Pagination (limit/offset) for snapshot lists
- [x] Bug fixes: snapshot filenames use UUID not timestamp, secondary sort key, transaction wrapping, deleted_at checks, SnapshotSummary type without content_path

### Phase 1b: Compile/Export ✅
*Pulled forward from Phase 5 — no dependency on auth or sync*

- [x] Pandoc integration (docx, epub, PDF, markdown output via wkhtmltopdf)
  - Tree-walk collects documents in binder sort_order, skips deleted and compile_include=0
  - Assembled HTML: title page (title, subtitle, date) + chapter sections
  - Pandoc via `spawn`/`execFile` (stdin piping, no shell injection)
- [x] Per-document include/exclude toggle in CompileDialog checklist
  - PATCH endpoint for compile_include, pending-aware UI (disables export while saving)
- [x] Compile preview (pure HTML in new tab, CSP-protected)
- [x] Saved compile configurations CRUD (compile_configs table, API endpoints)
- [x] Title page auto-generation (novel title, subtitle, date)
- [x] CompileDialog UI: format selector, document checklist, preview/export buttons
- [x] Code review fixes: removed broken double-invocation, XSS prevention, O(N) tree-walk, COALESCE/null fix, missing-file warnings

### Interstitial: Theming ✅
*Pulled forward from Phase 5*

- [x] CSS custom properties system (~27 variables)
- [x] Dark theme (warm aged-leather aesthetic)
- [x] System → Light → Dark cycle with localStorage persistence
- [x] Flash prevention (inline script in app.html)
- [x] Spellcheck toggle with persistence

### Phase 1c: Batch Import ✅
*Pulled forward — bulk ingest for multi-novel libraries*

- [x] Recursive `.scriv` scanner (async, depth-limited, symlink-safe, skips hidden/system dirs)
- [x] Scan endpoint with homedir boundary, tilde expansion, duplicate detection
- [x] Batch import endpoint with per-path error isolation, homedir boundary, partial success counting
- [x] Reworked library UI: 7-state import modal, project checklist, select all/deselect, AbortController
- [x] Warning/success CSS custom properties in theme system
- [x] Bug fixes: tilde expansion, modal close during scan, prefix bypass, server-side trim
- [x] Code review fixes (Codex): path-separator-aware homedir check, defense-in-depth trim

### Phase 1 (remaining): The Writing Room 🖋️
*Goal: Full local writing experience beyond MVP*

- [ ] Import Scrivener snapshots (if present in .scriv)
- [ ] Richer .scriv import (iterate on RTF edge cases: footnotes, annotations, embedded images)

### Phase 2: The Lock and Key 🔐
*Goal: Two users, protected access*

- [ ] User auth (login/logout/sessions via SvelteKit hooks — re-evaluate Express if auth complexity demands it)
- [ ] Writer vs Archivist roles
- [ ] Archivist admin panel
- [ ] Trash management (restore/purge)
- [ ] Audit log
- [ ] Storage monitoring dashboard

### Phase 3: The Scriptorium Opens 🌐
*Goal: Kyla accesses from anywhere*

- [ ] Sync protocol implementation (see Sync Protocol section)
- [ ] Service worker + IndexedDB for offline cache
- [ ] Save queue with offline resilience
- [ ] Session-expiry-safe queue (re-auth without data loss)
- [ ] Cloudflare Tunnel or Tailscale setup
- [ ] HTTPS enforcement
- [ ] Google Drive backup via server-side rclone
- [ ] Backup health dashboard
- [ ] SSE or polling for near-real-time sync when online

### Phase 4: The Reference Desk 📚
*Goal: Cross-novel knowledge*

- [ ] Character entities with profiles
- [ ] World groupings
- [ ] Cross-novel linking (character appearances, sequel relationships)
- [ ] Tag system for documents
- [ ] Advanced search (filter by world, novel, character, status)
- [ ] Character/world graph visualization
- [ ] Image upload with proxy generation (sharp)

### Phase 5: The Bindery ✨
*Goal: Polish and output*

- [ ] Corkboard/index card view
- [ ] Word count targets and progress tracking
- [ ] Focus/distraction-free writing mode
- [ ] Extended themes (Victorian aesthetic, custom palettes)
- [ ] Docker packaging for easy deployment

---

## Decisions Made

1. **SvelteKit (single-process, no Express for MVP)** — `+server.js` endpoints handle the API. Single process, no CORS, adapter-node for deployment. Express deferred unless auth/sync complexity demands it in Phase 2+. Both Codex and Gemini independently recommended this.
2. **TipTap (ProseMirror)** — robust, well-maintained, Svelte-compatible, clean HTML output, extensible schema. Custom plugins for character annotations etc. in Phase 4. Note: svelte-tiptap is community-maintained; verify maturity early.
3. **SQLite via better-sqlite3** — metadata, tree, versions, links, FTS5 search. DB initialized in `hooks.server.js`.
4. **File is source of truth for content** — HTML files on disk, SQLite for metadata. FTS5 mirrors content for search. Atomic writes via temp-file → rename → SQLite transaction.
5. **UUID directories, not slugs** — `/data/{novel-uuid}/docs/` avoids moving directory trees on novel rename. Slugs stay in metadata for display.
6. **@iarna/rtf-to-html** — RTF conversion for .scriv import (validated: 14/14 files, zero errors). `fast-xml-parser` for .scrivx binder tree.
7. **sharp** — image proxy generation, Phase 4+ (verify ARM/Pi builds)
8. **Server is source of truth** — clients cache working set locally for offline/lag-free writing, sync diffs when connected. Full offline support for rural Maine conditions.
9. **PWA, not native app** — cross-platform, works on any browser
10. **Same app, role-gated** — Archivist sections visible only to admin role
11. **Search from MVP** — SQLite FTS5 is essentially free; search is a core writing need for a large document library
12. **.scriv import in MVP** — this is the primary ingest path; basic import (text + structure) is MVP, rich RTF features iterate in Phase 1
13. **Worlds deferred to Phase 4** — novels exist at library root in Phases 1-3

## Open Questions

1. **Collaborative editing?** Probably not needed — last-save-wins with snapshots preserving both versions is fine for two users unlikely to edit simultaneously.
2. **Domain?** scriptorium.something? Or just a local network name?
3. **Naming convention for novels imported from .scriv?** Preserve Scrivener project names or let writer rename on import?

---

## Security Considerations

- All traffic over HTTPS (Cloudflare Tunnel handles this)
- Passwords hashed with bcrypt (cost factor 12+)
- Session tokens with httpOnly, secure, sameSite cookies
- Session expiry during offline: save queue persists independently; re-auth before flush; NEVER drop queued work
- Rate limiting on auth endpoints
- No raw SQL — parameterized queries only
- Content-Security-Policy headers
- Input sanitization on all user content (TipTap outputs safe HTML, but belt-and-suspenders)
- File paths: NEVER constructed from user input without sanitization
- Backup encryption: Google Drive at rest, consider GPG for extra paranoia

---

## Review History

- **v0.1** — Initial spec (Feb 19, 2026)
- **v0.2** — Revised after Claude Code review. Changes:
  - Resolved React/SvelteKit inconsistency throughout (SvelteKit confirmed)
  - Added full Sync Protocol section with payload format, conflict resolution for both content and tree operations
  - Moved .scriv import from Phase 1 → Phase 2
  - Added full-text search (FTS5) to Phase 1
  - Added sync API routes, search routes, compile/export routes
  - Specified sharp for image processing with ARM/Pi deployment note
  - Made Novel↔World many-to-many relationship explicit
  - Added session-expiry-safe offline queue behavior
  - Added storage monitoring to Archivist dashboard
  - Added compile_include boolean to Document model
  - Added minimum hardware notes for Pi deployment
  - Added review history section
- **v0.3** — Pre-review tightening. Changes:
  - Added `server_version` to Novel, Folder, Document entity definitions (sync protocol referenced it but data model didn't)
  - Decided Express.js over Fastify (removed ambiguity)
  - Added sort_order renormalization note
  - Documented full set of sync operation types (was only showing 4 of 8 in examples)
  - Clarified compile_include vs compile API include_ids relationship
  - Noted Worlds are Phase 4; novels at library root in Phases 1-3
- **v0.4** — Revised after Codex + Gemini review. Changes:
  - **SvelteKit-only for MVP** — dropped Express; `+server.js` endpoints, single process, no CORS. Both reviewers independently recommended this. Express deferred to Phase 2+ if auth complexity demands it.
  - **File is source of truth for content** — resolved ambiguity about where content lives. Files on disk are canonical; SQLite stores metadata only; FTS5 mirrors content for search. (Codex)
  - **Atomic write strategy** — temp file → fsync → rename → SQLite transaction. Startup consistency check reconciles orphaned files. (Both)
  - **UUID directories, not slugs** — `/data/{novel-uuid}/` avoids moving directory trees on novel rename. (Codex)
  - **Cyclic move detection** — server validates new_parent isn't a descendant of moved node, preventing the "Ouroboros" cycle bug. (Gemini)
  - **Move-of-deleted-child** — defined: delete wins, client notified. (Codex)
  - **Sync batch processing order** — creates → updates → moves → deletes, with per-operation error propagation. (Codex)
  - **old_parent_id in tree_move payload** — enables deterministic rollback on rejected moves. (Codex)
  - **Clock skew note** — acceptable for two-user system; fall back to server-receive ordering if needed. (Codex)
  - **Client-side coalescing** — multiple offline updates to same entity coalesced before sync. (Codex)
  - **sort_order feedback** — server returns adjusted values to client after collision resolution or renormalization. (Both)
  - **.scriv import fixed to MVP** — resolved contradiction (was "Phase 2" in one place, MVP in another). RTF library confirmed as `@iarna/rtf-to-html` (validated). (Codex)
  - **Import validation report** added to MVP checklist. (Codex)
  - **DATA_ROOT env variable** added for configurable data directory. (Gemini)

- **v0.5** — Progress update and phase shuffle. Changes:
  - **MVP marked complete** — all 14 core items implemented and shipped
  - **Phase 1a (Snapshot Browser) marked complete** — timeline panel, preview, non-destructive restore, manual snapshots, pagination, bug fixes. Reviewed by Codex + Gemini + Claude.
  - **Theming marked complete** — CSS custom properties, dark mode, system/light/dark cycle, flash prevention, spellcheck persistence. Reviewed by Codex + Gemini + Claude.
  - **Compile/export pulled forward to Phase 1b** — no dependency on auth or sync; Pandoc integration is next
  - **Phase 5 slimmed** — compile/export and theming moved to earlier phases; remaining: corkboard, word count targets, focus mode, extended themes, Docker

- **v0.6** — Phase 1b complete. Changes:
  - **Compile/export marked complete** — Pandoc integration (docx, epub, PDF, markdown), CompileDialog UI, tree-walk document collection, HTML assembly with title page, compile_include toggle, saved configurations CRUD, HTML preview with CSP
  - **API docs expanded** — compile endpoint details (body format, pipeline, PDF engine), preview query params, PUT/DELETE for configs, compile_include toggle via PATCH
  - **Code review fixes** — broken double-invocation removed, XSS prevention via CSP, O(N) tree-walk with Map pre-indexing, COALESCE/null bug fixed, missing-file warnings in assembler, pending-toggle tracking in UI, JSON.parse guarded

- **v0.7** — Phase 1c complete. Changes:
  - **Batch import marked complete** — recursive `.scriv` scanning, batch API with per-path error isolation, reworked library UI with 7-state import modal
  - **Security hardening** — homedir boundary with path-separator-aware prefix check, tilde expansion, server-side trim, symlink safety via `dirent.isDirectory()`
  - **Bug hunt + code review cycle** — 4 bugs found and fixed, then Codex review caught prefix bypass vulnerability
  - **Test coverage** — 149 tests across 11 files

---

*"The writer writes. The archivist keeps. Neither needs to think about the other's work."*

— Scriptorium design document, v0.7
