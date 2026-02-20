# Scriptorium
### A preservation-first writing application

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
│  │           │  │   tree, links) │   │
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
- Proxies auto-generated on upload at three breakpoints:
  - Thumbnail: 150px (for binder/card views)
  - Medium: 400px (for inline display on mobile)
  - Large: 800px (for inline display on desktop)
- Original preserved for archival/export

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

### Storage Estimates (with images)
- Text-only: ~75MB/month of snapshots at heavy use
- With images: depends heavily on usage. Budget 500MB-1GB/month if image-heavy.
- Proxies add ~30% overhead on top of originals (3 sizes)
- Still very manageable: a year of heavy use with images < 15GB

---

## Data Model

### Core Entities

**Library** — top-level container (one per user, but could support multiple)

**World** — a fictional universe grouping novels together
- name, description, notes
- e.g., "The Silvers Universe", "Antarctica", "Standalone"

**Novel** — a writing project
- title, subtitle, status (draft/revision/complete/abandoned)
- belongs to one or more Worlds
- word count target (optional)
- compile settings

**Folder** — organizational container within a novel
- title, position in tree
- can nest (chapters containing scenes, acts containing chapters, etc.)
- types: Manuscript, Research, Notes, Characters, Trash (per-novel)

**Document** — the atomic unit of writing
- title, content (HTML from TipTap), synopsis, notes
- position in tree (under a Folder or directly under Novel)
- status labels (draft, revised, final, etc.)
- word count (computed)
- created_at, updated_at

**Snapshot** — immutable versioned copy of a Document
- document_id, content, word_count, created_at
- auto-created on save (debounced: not more than 1 per 2 minutes)
- NEVER deleted except by Archivist with explicit confirmation
- reason: "autosave" | "manual" | "pre-restructure"

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
- **CANNOT**: permanently delete anything, access admin panel, modify backup settings

### Archivist (Lara)
- Everything Writer can do, PLUS:
- Permanently empty trash (with confirmation + cooldown)
- Restore from trash
- View all snapshots across all documents
- Import .scriv projects
- Manage backup configuration
- View backup status/health
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
- **Runtime:** Node.js (already installed, v22)
- **Framework:** Express.js or Fastify
- **Database:** SQLite via better-sqlite3 (metadata, tree structure, versions, links)
- **Content storage:** Files on disk (HTML/JSON, one per document)
  - Human-readable, greppable, git-friendly
  - Path: `/data/{user}/{novel-slug}/docs/{doc-id}.html`
- **Snapshot storage:** `/data/{user}/{novel-slug}/snapshots/{doc-id}/{timestamp}.html`
- **Auth:** bcrypt + express-session (simple) or Passport.js
  - Stretch: passkeys/WebAuthn for passwordless
- **Backup:** rclone to Google Drive on cron (server-side only — Kyla never touches this)

### Frontend
- **Editor:** TipTap (ProseMirror-based)
  - Rich text: bold, italic, headers, block quotes, lists
  - Inline notes/comments (for writer's annotations)
  - Word count (live)
  - Focus mode (dim everything except current paragraph)
  - Markdown shortcuts (type `# ` to get a heading, etc.)
- **Framework:** React (TipTap has great React bindings)
  - Or: Svelte/SvelteKit for lighter weight? Worth considering.
- **Tree/Binder:** Sidebar with drag-and-drop reordering
  - dnd-kit or similar
- **Responsive:** Must work on phone screens
  - Sidebar collapses to hamburger menu on mobile
  - Editor fills screen
  - Phone experience = "open app, tap document, write"
- **Offline resilience:** Service worker caches current document
  - NOT a full offline-first app (too heavy for old devices)
  - Just enough to survive a subway tunnel
  - Queues changes and syncs when back online
  - Clear visual indicator: "Saved ✓" vs "Saving..." vs "Offline — will sync"

### Deployment
- **Phase 1-2:** `localhost:3000` on Lara's machine
- **Phase 3:** Cloudflare Tunnel for external access (free, encrypted)
  - `scriptorium.yourdomain.com` or similar
  - Alternative: Tailscale for family-only access
- **Stretch:** Docker container for easy deployment to VPS/Pi
  - Single `docker-compose up` to run everything
  - SQLite file + content directory = entire state (easy backup)

---

## .scriv Import

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
3. Rebuild tree in Scriptorium's data model
4. Import snapshots if present
5. Map Scrivener labels/status to Scriptorium equivalents
6. Preserve UUIDs as import metadata (for re-import/comparison)

**Library:** `@iarna/rtf-to-html` or `rtf.js` for RTF conversion

---

## Versioning Strategy

### Automatic Snapshots
- **Trigger:** Document save (debounced: max 1 snapshot per 2 minutes of active editing)
- **Also trigger on:** document move, rename, or any structural change
- **Storage:** Full content copy (not diffs — simpler, disk is cheap)
- **Retention:** Forever (only Archivist can prune, and even then with warnings)

### Snapshot Browsing (Writer)
- Timeline view: "3 hours ago — 2,847 words" / "Yesterday — 2,612 words"
- Side-by-side diff view (optional, stretch goal)
- "Restore this version" creates a NEW snapshot of current state, THEN reverts
  - So restoration is itself non-destructive

### Conflict Resolution (Offline Sync)
When Kyla comes back online after writing offline:
1. Client presents its changes to the server
2. Server checks: has the document changed server-side since client's last sync?
3. **If no server changes:** client version accepted, done.
4. **If server has changes:** client version WINS (freshest human intent), but the server's pre-sync version is automatically preserved as a snapshot with reason "pre-sync-conflict". No work is ever lost from either side.
5. Sync status shown clearly: "Synced ✓" / "Syncing..." / "Offline — changes saved locally"

### Offline Cache Strategy
- **Always cached:** Full binder tree for entire library (metadata only — tiny)
- **Cached on open:** Any document Kyla opens gets cached locally and STAYS cached
- **Optional offload:** A "free up space" toggle in settings lets her push local copies to server-only and remove them from device cache
- **Cache budget:** Configurable max local storage (default: 100MB, adjustable down for old phones)
- **Indicator:** Library view shows which documents are available offline (subtle icon)
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

### Library
- GET  /api/novels
- POST /api/novels
- GET  /api/novels/:id
- PUT  /api/novels/:id
- DELETE /api/novels/:id (soft-delete only)

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

### Characters & Links (Phase 2+)
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
- POST /api/admin/import/scriv (upload .scriv directory)
- GET  /api/admin/audit-log

---

## Phase Plan

### Phase 1: The Writing Room 🖋️
*Goal: Kyla can write in it locally*

- [ ] Project scaffolding (Node.js + Express + React/Vite)
- [ ] SQLite schema for novels, folders, documents, snapshots
- [ ] File-based content storage
- [ ] TipTap editor with basic rich text
- [ ] Sidebar binder tree with drag-and-drop
- [ ] Auto-save with snapshot creation
- [ ] New novel / new document / new folder
- [ ] Soft-delete to trash
- [ ] .scriv import tool
- [ ] Basic responsive layout (works on phone)

### Phase 2: The Lock and Key 🔐
*Goal: Two users, protected access*

- [ ] User auth (login/logout/sessions)
- [ ] Writer vs Archivist roles
- [ ] Archivist admin panel
- [ ] Trash management (restore/purge)
- [ ] Snapshot browser with timeline
- [ ] Audit log

### Phase 3: The Scriptorium Opens 🌐
*Goal: Kyla accesses from anywhere*

- [ ] Cloudflare Tunnel or Tailscale setup
- [ ] HTTPS enforcement
- [ ] Service worker for offline resilience
- [ ] Save queue for intermittent connectivity
- [ ] Google Drive backup via server-side rclone
- [ ] Backup health dashboard

### Phase 4: The Reference Desk 📚
*Goal: Cross-novel knowledge*

- [ ] Character entities with profiles
- [ ] World groupings
- [ ] Cross-novel linking (character appearances, sequel relationships)
- [ ] Tag system for documents
- [ ] Search across entire library
- [ ] Character/world graph visualization

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
2. **TipTap (ProseMirror)** — robust, well-maintained, Svelte-compatible, clean HTML output, extensible schema. Custom plugins for character annotations etc. in Phase 4.
3. **SQLite via better-sqlite3** — metadata, tree, versions, links
4. **Server is source of truth** — clients cache working set locally for offline/lag-free writing, sync diffs when connected. Full offline support for rural Maine conditions.
5. **PWA, not native app** — cross-platform, works on any browser
6. **Same app, role-gated** — Archivist sections visible only to admin role

## Open Questions

1. **Collaborative editing?** Probably not needed — last-save-wins with snapshots preserving both versions is fine for two users unlikely to edit simultaneously.
2. **Domain?** scriptorium.something? Or just a local network name?
3. **Naming convention for novels imported from .scriv?** Preserve Scrivener project names or let writer rename on import?

---

## Security Considerations

- All traffic over HTTPS (Cloudflare Tunnel handles this)
- Passwords hashed with bcrypt (cost factor 12+)
- Session tokens with httpOnly, secure, sameSite cookies
- Rate limiting on auth endpoints
- No raw SQL — parameterized queries only
- Content-Security-Policy headers
- Input sanitization on all user content (TipTap outputs safe HTML, but belt-and-suspenders)
- File paths: NEVER constructed from user input without sanitization
- Backup encryption: Google Drive at rest, consider GPG for extra paranoia

---

*"The writer writes. The archivist keeps. Neither needs to think about the other's work."*

— Scriptorium design document, v0.1
