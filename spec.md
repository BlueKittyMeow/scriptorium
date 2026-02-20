# Scriptorium
### A preservation-first writing application
### Design Document v0.3

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
│  │  Express   │  │   SQLite DB   │   │
│  │  API +     │  │  (metadata,   │   │
│  │  Auth      │  │   versions,   │   │
│  │            │  │   tree, links) │   │
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
- Originals stored on server: `/data/{user}/{novel-slug}/images/{uuid}.{ext}`
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
- **Framework:** Express.js (simpler session/auth middleware story; Fastify is faster but adds complexity without benefit at this scale)
- **Database:** SQLite via better-sqlite3 (metadata, tree structure, versions, links, FTS5 search)
- **Image processing:** sharp (proxy generation)
- **Content storage:** Files on disk (HTML/JSON, one per document)
  - Human-readable, greppable, git-friendly
  - Path: `/data/{user}/{novel-slug}/docs/{doc-id}.html`
- **Snapshot storage:** `/data/{user}/{novel-slug}/snapshots/{doc-id}/{timestamp}.html`
- **Auth:** bcrypt + express-session (simple) or Passport.js
  - Stretch: passkeys/WebAuthn for passwordless
- **Backup:** rclone to Google Drive on cron (server-side only — Kyla never touches this)

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
- **Phase 1-2:** `localhost:3000` on Lara's machine
- **Phase 3:** Cloudflare Tunnel for external access (free, encrypted)
  - `scriptorium.yourdomain.com` or similar
  - Alternative: Tailscale for family-only access
- **Stretch:** Docker container for easy deployment to VPS/Pi
  - Single `docker-compose up` to run everything
  - SQLite file + content directory = entire state (easy backup)
  - **Pi deployment note:** verify sharp ARM builds; consider minimum Pi 3B+ or better for SQLite + image processing + Express under load

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

1. **Moves/reorders:** Last-write-wins by timestamp. If client moved doc A to folder X at 9:15pm, and server moved doc A to folder Y at 9:10pm, client wins (more recent). Server's tree state before applying is snapshotted.

2. **Concurrent creation:** Both creations are accepted. If they'd occupy the same sort_order, server adjusts the later one's sort_order to avoid collision.

3. **Move to deleted parent:** If client moves a doc into a folder that was deleted server-side, the move is rejected and the doc stays in its pre-move location. Client is notified: "Folder X was deleted — your document stayed in its original location."

4. **Delete of moved child:** If client deletes a doc that was moved server-side to a new location, the soft-delete still applies (just at its new location). No conflict.

5. **Structural snapshot:** On any tree conflict, the server saves a full tree-state snapshot (JSON of the entire binder structure) for Archivist review.

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

**Moved to Phase 2** (per review — RTF edge cases shouldn't block core writing loop).

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
2. For each document: convert RTF → HTML (via `rtf-parser` or similar)
   - **Known complexity:** Scrivener RTF can include embedded images, footnotes, annotations, and custom styling. Initial import targets clean text + basic formatting. Rich features iterate in later passes.
3. Rebuild tree in Scriptorium's data model
4. Import snapshots if present
5. Map Scrivener labels/status to Scriptorium equivalents
6. Preserve UUIDs as import metadata (for re-import/comparison)

**Library:** `@iarna/rtf-to-html` or `rtf.js` for RTF conversion. Evaluate against real .scriv files from Kyla's library before committing.

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
- POST /api/novels/:id/compile (generate export)
  - Body: `{ format: "docx"|"epub"|"pdf"|"markdown", include_ids: [...], config_id: "..." }`
- GET  /api/novels/:id/compile/configs (saved compile configurations)
- POST /api/novels/:id/compile/configs (save a new compile configuration)
- GET  /api/novels/:id/compile/preview (HTML preview of compiled output)

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

### Phase 1: The Writing Room 🖋️
*Goal: Kyla can write in it locally*

- [ ] Project scaffolding (SvelteKit + Express API)
- [ ] SQLite schema for novels, folders, documents, snapshots
- [ ] FTS5 search index
- [ ] File-based content storage
- [ ] TipTap editor with basic rich text (verify svelte-tiptap maturity; fallback: thin custom wrapper)
- [ ] Sidebar binder tree with drag-and-drop
- [ ] Auto-save with snapshot creation
- [ ] New novel / new document / new folder
- [ ] Soft-delete to trash
- [ ] Basic full-text search
- [ ] Basic responsive layout (works on phone)

### Phase 2: The Lock and Key 🔐
*Goal: Two users, protected access, import*

- [ ] User auth (login/logout/sessions)
- [ ] Writer vs Archivist roles
- [ ] Archivist admin panel
- [ ] Trash management (restore/purge)
- [ ] Snapshot browser with timeline
- [ ] Audit log
- [ ] .scriv import tool (basic: text + structure; iterate on rich RTF features)
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

- [ ] Compile/export via Pandoc (docx, epub, PDF, markdown)
  - Compile = concatenate manuscript documents in binder order
  - **Per-document include/exclude toggle** — uncheck chapters that aren't ready
  - Compile preview before export
  - Save compile configurations (e.g., "Full manuscript", "First three chapters", "Contest submission")
  - Front/back matter templates (title page, copyright, dedication)
- [ ] Corkboard/index card view
- [ ] Word count targets and progress tracking
- [ ] Focus/distraction-free writing mode
- [ ] Themes (including, obviously, dark Victorian)
- [ ] Docker packaging for easy deployment

---

## Decisions Made

1. **SvelteKit** — compiles away, minimal bundle for old devices, good service worker story
2. **TipTap (ProseMirror)** — robust, well-maintained, Svelte-compatible, clean HTML output, extensible schema. Custom plugins for character annotations etc. in Phase 4. Note: svelte-tiptap is community-maintained; verify maturity early.
3. **SQLite via better-sqlite3** — metadata, tree, versions, links, FTS5 search
4. **Express.js** — simpler session/auth middleware; Fastify unnecessary at this scale
5. **sharp** — image proxy generation (verify ARM/Pi builds)
6. **Server is source of truth** — clients cache working set locally for offline/lag-free writing, sync diffs when connected. Full offline support for rural Maine conditions.
7. **PWA, not native app** — cross-platform, works on any browser
8. **Same app, role-gated** — Archivist sections visible only to admin role
9. **Search from Phase 1** — SQLite FTS5 is essentially free; search is a core writing need
10. **.scriv import in Phase 2** — RTF edge cases shouldn't block core writing loop
11. **Worlds deferred to Phase 4** — novels exist at library root in Phases 1-3

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

---

*"The writer writes. The archivist keeps. Neither needs to think about the other's work."*

— Scriptorium design document, v0.3
