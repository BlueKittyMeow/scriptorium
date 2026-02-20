# Scriptorium MVP — Implementation Roadmap
### One-shot build plan for "The Local Scriptorium"

**Scope:** Local-only, single-user, no auth, no sync. SvelteKit on `localhost:5173`. Ingest .scriv files, browse/edit in a binder tree, search everything, auto-save with snapshots.

**Spec reference:** `spec.md` v0.4, Phase Plan → MVP checklist.

---

## Layer 0: Scaffold
**~30 min** | No dependencies

**Goal:** Empty SvelteKit app that runs, with tooling configured.

- [ ] `npx sv create scriptorium-app` — SvelteKit, adapter-node, TypeScript
- [ ] Install runtime deps: `better-sqlite3`, `fast-xml-parser`, `@iarna/rtf-to-html`, `uuid`
- [ ] Install dev deps: `@types/better-sqlite3`
- [ ] Configure `DATA_ROOT` env variable (default `./data`)
- [ ] Directory structure:
  ```
  src/
  ├── lib/
  │   ├── server/           ← server-only modules
  │   │   ├── db.js         ← SQLite singleton + schema
  │   │   ├── files.js      ← atomic file read/write
  │   │   └── import/       ← .scriv import pipeline
  │   ├── types.ts          ← shared TypeScript types
  │   └── stores/           ← Svelte stores
  ├── routes/
  │   ├── +layout.svelte    ← app shell
  │   ├── +page.svelte      ← library view
  │   ├── novels/[id]/      ← novel workspace
  │   └── api/              ← +server.js endpoints
  └── hooks.server.js       ← DB init → event.locals
  ```
- [ ] `.gitignore` — add `data/`, `.svelte-kit/`
- [ ] Verify: `npm run dev` serves the default page

---

## Layer 1: Database & File Storage
**~1-2 hrs** | Depends on: Layer 0

**Goal:** SQLite schema running, atomic file writes working, ready for CRUD.

### 1a. Schema

```sql
CREATE TABLE novels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  status TEXT DEFAULT 'draft',
  word_count_target INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id),
  parent_id TEXT,
  title TEXT NOT NULL,
  folder_type TEXT,           -- manuscript/research/notes/characters/trash
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  novel_id TEXT NOT NULL REFERENCES novels(id),
  parent_id TEXT,
  title TEXT NOT NULL,
  synopsis TEXT,
  word_count INTEGER DEFAULT 0,
  compile_include INTEGER DEFAULT 1,
  sort_order REAL NOT NULL,
  last_snapshot_at TEXT,       -- for 2-min snapshot debounce
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  content_path TEXT NOT NULL,
  word_count INTEGER,
  reason TEXT NOT NULL,       -- autosave/manual/pre-restructure
  created_at TEXT NOT NULL
);

-- FTS5: indexes plain text only (HTML stripped before insert)
CREATE VIRTUAL TABLE documents_fts USING fts5(
  doc_id UNINDEXED,
  title,
  content                     -- plain text, NOT raw HTML
);
```

### 1b. DB module (`src/lib/server/db.js`)
- `initDb()` — open/create `DATA_ROOT/scriptorium.db`, run schema if new, enable WAL mode
- Called in `hooks.server.js`, attached to `event.locals.db`

### 1c. Atomic file helpers (`src/lib/server/files.js`)
- `writeContentFile(novelId, docId, html)` — write `.tmp` → `fsync` → `rename`
- `readContentFile(novelId, docId)` — read HTML from disk, return string
- `writeSnapshotFile(novelId, docId, timestamp, html)` — same atomic pattern
- `ensureNovelDirs(novelId)` — create `DATA_ROOT/{uuid}/docs/` and `snapshots/`
- `stripHtml(html)` — strip tags, return plain text (for FTS indexing and word count)

**Error recovery:** If rename succeeds but the subsequent SQLite update fails, the file is orphaned (content safe, metadata stale). A startup consistency check scans `DATA_ROOT` and reconciles orphaned files against the DB. This is a rare edge case on local filesystem — the check is cheap insurance.

### Verify
Write a file, read it back, confirm content matches. Confirm DB tables exist.

---

## Layer 2: CRUD API Routes
**~2-3 hrs** | Depends on: Layer 1

**Goal:** Full REST API, testable via curl. No UI yet.

### 2a. Novels
| Method | Route | Action |
|--------|-------|--------|
| GET | `/api/novels` | List all non-deleted |
| POST | `/api/novels` | Create (UUID, dirs) |
| GET | `/api/novels/[id]` | Single novel |
| PUT | `/api/novels/[id]` | Update title/status |
| DELETE | `/api/novels/[id]` | Soft-delete |

### 2b. Tree (folders + documents)
| Method | Route | Action |
|--------|-------|--------|
| GET | `/api/novels/[id]/tree` | Full binder tree (recursive JSON) |
| POST | `/api/novels/[id]/tree/nodes` | Create folder or document |
| PUT | `/api/novels/[id]/tree/reorder` | Move/reparent node |
| DELETE | `/api/novels/[id]/tree/nodes/[nodeId]` | Soft-delete |

`POST .../tree/nodes` body: `{ type: "folder"|"document", parent_id, title, sort_order }`

`PUT .../tree/reorder` body: `{ node_id, node_type: "folder"|"document", new_parent_id, new_sort_order }`

### 2c. Documents
| Method | Route | Action |
|--------|-------|--------|
| GET | `/api/documents/[id]` | Metadata + content (from file) |
| PUT | `/api/documents/[id]` | Save content → atomic write, snapshot if >2min, update FTS5 |
| GET | `/api/documents/[id]/snapshots` | List snapshots |
| GET | `/api/documents/[id]/snapshots/[snapId]` | Read snapshot content |

### 2d. Search
| Method | Route | Action |
|--------|-------|--------|
| GET | `/api/search?q=...&novel=...` | FTS5 query → doc IDs + snippets |

### Key behaviors
- Document save (`PUT /api/documents/[id]`):
  1. Atomic write HTML to disk
  2. Strip HTML → plain text for word count + FTS
  3. Update `word_count`, `updated_at` in SQLite
  4. Create snapshot if >2 min since `last_snapshot_at`; update `last_snapshot_at`
  5. Update FTS5 index (insert/replace with **plain text**, not raw HTML)
- Tree delete cascades: deleting a folder sets `deleted_at` on all children
- **FTS consistency:** soft-delete removes entry from FTS5; restore re-inserts it. This prevents search results leaking deleted documents.

### Verify
curl through all endpoints. Confirm files on disk match DB state.

---

## Layer 3: .scriv Import
**~2-3 hrs** | Depends on: Layer 2 | **Can parallelize with Layer 4**

**Goal:** Point at a `.scriv` directory, get a fully populated novel.

### Pipeline (`src/lib/server/import/scriv.js`)

Already proven in `rtf-test/scriv-parse-test.mjs`. Port to production:

1. **Parse .scrivx** — `fast-xml-parser` extracts binder tree, labels, statuses
2. **Create novel** — title from project name, UUID, create dirs
3. **Walk binder recursively:**
   - `Folder*` types → create folder row in SQLite
   - `Text` types → create document row + convert RTF:
     - Read RTF file (handle both old `{id}.rtf` and new `Files/Data/{UUID}/content.rtf` layouts)
     - Convert via `@iarna/rtf-to-html`
     - Strip HTML/body wrapper, keep inner content
     - Atomic write to `DATA_ROOT/{novel-uuid}/docs/{doc-uuid}.html`
     - Compute word count, update SQLite + FTS5
   - Store synopsis in `documents.synopsis` if present
   - Skip media files (images, PDFs) — log as skipped
4. **Flag manuscript root** — identify the "Draft" / "Manuscript" root folder (Scrivener's compile target) and tag it as `folder_type: 'manuscript'` so compile knows where to start
5. **Map Scrivener labels/statuses** → store as document metadata
6. **Return validation report:**
   ```json
   {
     "novel_id": "...",
     "novel_title": "...",
     "docs_imported": 14,
     "folders_created": 12,
     "files_skipped": 4,
     "errors": [],
     "warnings": ["4 media files skipped (images/PDFs)"]
   }
   ```

### API endpoint
`POST /api/admin/import/scriv` — body: `{ path: "/absolute/path/to/Project.scriv" }`

Local-only MVP: user provides filesystem path, no upload needed. The `importScriv(path)` function signature is designed so that Phase 3 can swap the front door (file upload → unzip to temp dir → pass path to same function).

### Verify
Import the Talamus test project. Confirm tree structure and content matches `scriv-parse-test.mjs` output.

---

## Layer 4: App Shell & Binder Tree UI
**~2-3 hrs** | Depends on: Layer 2 | **Can parallelize with Layer 3**

**Goal:** Working sidebar, novel navigation, binder tree with click-to-select.

### 4a. Layout (`+layout.svelte`)
- Sidebar (280px desktop, slide-out drawer on mobile) + main content area
- Top bar: app name, search trigger, hamburger toggle on mobile

### 4b. Library view (`+page.svelte`)
- List of novels (simple cards with title, status, total word count)
- "New Novel" button
- "Import .scriv" button (path input modal for MVP)

### 4c. Novel workspace (`novels/[id]/+page.svelte`)
- Sidebar: binder tree from `GET /api/novels/[id]/tree`
- Recursive tree component: expandable folders, clickable documents
- Click document → loads in main content area (placeholder until Layer 5)
- Folder/document icons, trash section at bottom (dimmed)

### 4d. Binder interactions
- Drag-and-drop reorder via `svelte-dnd-action` (or similar)
- On drop → `PUT /api/novels/[id]/tree/reorder`
- Context actions: New Document, New Folder, Rename, Move to Trash
- "New Document" / "New Folder" buttons at sidebar bottom

### 4e. Svelte stores (`src/lib/stores/`)
- `novelStore` — current novel metadata
- `treeStore` — binder tree (reactive, updates on mutations)
- `activeDocStore` — currently selected document ID

### Verify
Navigate between novels, expand/collapse folders, click to select documents (editor area shows placeholder text).

---

## Layer 5: TipTap Editor
**~2-3 hrs** | Depends on: Layer 4

**Goal:** Rich text editing with auto-save and snapshot creation.

### 5a. Editor component (`src/lib/components/Editor.svelte`)
- **Use TipTap core with a thin Svelte wrapper** (not `svelte-tiptap`). Community wrapper maturity is uncertain; a 15-line `onMount`/`onDestroy` wrapper gives full control with zero abstraction risk.
  ```js
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import Placeholder from '@tiptap/extension-placeholder';
  ```
- **SSR guard required:** TipTap is browser-only. Wrap in `{#if browser}` or use dynamic import to prevent "document is not defined" errors during SvelteKit server rendering.
- Extensions: StarterKit (bold, italic, headings, lists, blockquote, code block), Placeholder
- Toolbar: B / I / H1-H3 / list / blockquote / undo / redo
- Live word count in editor footer

### 5b. Auto-save
- Debounce: 2 seconds after last keystroke
- `PUT /api/documents/[id]` with editor `.getHTML()`
- Status indicator: "Saved" / "Saving..." / "Unsaved changes"
- Server-side: snapshot created if >2 min since last

### 5c. Document loading
- `activeDocStore` change → `GET /api/documents/[id]`
- Set editor content via `editor.commands.setContent(html)`
- Handle new/empty documents gracefully

### Verify
Open imported document, edit text, see "Saving..." → "Saved". Refresh page — content persists. Check snapshot files appear in `DATA_ROOT/{novel}/snapshots/`.

---

## Layer 6: Search
**~1 hr** | Depends on: Layer 5

**Goal:** Full-text search across the entire library.

### UI
- Search input in top bar (or keyboard shortcut `Ctrl+K` / `Cmd+K`)
- Results panel: matching documents with highlighted snippets
- Click result → navigate to that document in its novel
- Optional: scope toggle (all library vs current novel)

### Wiring
- `GET /api/search?q=...` already built in Layer 2
- FTS5 `highlight()` function for snippet generation
- Debounce search input (300ms)

### Verify
Import Talamus, search for a character name, see results with context, click through to document.

---

## Layer 7: Soft-Delete & Trash
**~1 hr** | Depends on: Layer 5

**Goal:** Trash and restore with proper UI treatment.

### Behavior
- "Move to Trash" → sets `deleted_at` (folder trash cascades to children)
- **FTS5 cleanup:** remove trashed documents from FTS index on delete
- Trash section at bottom of binder tree: dimmed, strikethrough, collapsible
- "Restore" action on trashed items → clears `deleted_at`, restores to original parent (or novel root if parent deleted), **re-indexes in FTS5**
- Trashed items excluded from search and compile
- **No permanent delete in MVP** — preservation-first. Permanent purge requires Archivist role (Phase 2).

### Verify
Trash a document, confirm it appears in trash section. Restore it, confirm it's back in the tree.

---

## Layer 8: Polish & Responsive
**~1-2 hrs** | Depends on: Layers 5-7

**Goal:** Usable on phones, handles edge cases, looks like a writing app.

### Responsive
- Mobile: sidebar as slide-out drawer, editor fills viewport
- Hamburger toggle
- Touch-friendly tap targets (44px minimum)
- Test at 375px width

### Empty & loading states
- No novels yet → welcome message + import prompt
- Empty novel → "Add your first document" prompt
- Empty search → "No results" message
- Loading → skeleton/spinner

### Visual
- Clean serif typography for editor (good line-height, comfortable reading)
- Subtle color palette — writer-friendly, not developer-ugly
- Proper tree indentation with expand/collapse icons

### Edge cases
- Sort-order renormalization deferred to Phase 2+ (float midpoint precision won't exhaust in MVP-scale usage — novels rarely exceed 50-100 items per folder)
- Save failure handling (show error, retry)

---

## Stretch: Basic Compile/Export
**~2-3 hrs** | Depends on: Layer 8

**Goal:** Stitch manuscript into a downloadable file.

- Compile UI: checklist of manuscript documents (binder order), toggle include/exclude
- `POST /api/novels/[id]/compile` → concatenate included docs in order
- Output as single HTML file (always works)
- If Pandoc available on system → also offer docx export
- Download link / button

---

## Dependency Graph

```
Layer 0 (scaffold)
  └→ Layer 1 (db + files)
       └→ Layer 2 (CRUD API)
            ├→ Layer 3 (.scriv import)  ←── can parallelize
            └→ Layer 4 (app shell + tree) ←── can parallelize
                 └→ Layer 5 (TipTap editor)
                      ├→ Layer 6 (search)     ←── can parallelize
                      └→ Layer 7 (trash)      ←── can parallelize
                           └→ Layer 8 (polish)
                                └→ Stretch (compile)
```

## Time Estimates

| Layer | What | Optimistic | Realistic |
|-------|------|-----------|-----------|
| 0 | Scaffold | 30m | 30m |
| 1 | DB + File Storage | 1h | 2h |
| 2 | CRUD API | 2h | 3h |
| 3 | .scriv Import | 2h | 3h |
| 4 | App Shell + Binder | 2h | 3h |
| 5 | TipTap Editor | 2h | 3h |
| 6 | Search | 45m | 1.5h |
| 7 | Trash | 45m | 1.5h |
| 8 | Polish | 1h | 2h |
| S | Compile (stretch) | 2h | 3h |
| | **Total** | **~14h** | **~22h** |

Optimistic: a focused weekend. Realistic: 2-3 sessions.

---

## Reviewer Notes

### Decisions resolved (from v0.1 review)
1. **svelte-tiptap → TipTap core + thin wrapper.** Community wrapper maturity is uncertain; 15-line Svelte wrapper gives full control. (Gemini)
2. **FTS5 indexes plain text, not HTML.** Strip tags before insert. De-index on soft-delete, re-index on restore. (Both)
3. **Sort-order renormalization deferred to Phase 2+.** Float midpoint precision won't exhaust at MVP scale. (Gemini)
4. **Import as filesystem path is fine for MVP.** `importScriv(path)` signature lets Phase 3 swap to upload → temp dir → same function. (Gemini)
5. **DB is purely metadata; file is source of truth for content.** FTS5 mirrors plain text for search only. (Codex)
6. **Directory layout pinned now:** `DATA_ROOT/{novel-uuid}/docs/{doc-uuid}.html`. No slug paths.

### What's intentionally deferred

**From the spec but not in MVP schema:**
- Document `notes` field (RTF notes from Scrivener — imported into synopsis for MVP, full notes support Phase 1)
- Status labels as a separate table (MVP uses a plain `status` text column on documents)
- `server_version` on all entities (sync is Phase 3)
- `content_hash` / integrity checks (useful for sync in Phase 3, over-engineering for local MVP)

**Features:**
- Auth, roles, permissions (Phase 2)
- Permanent trash purge (Phase 2 — requires Archivist role)
- Sync protocol, offline cache, service worker (Phase 3)
- Characters, worlds, cross-novel links (Phase 4)
- Image upload/proxy, compile configs, focus mode, themes (Phase 5)
- No testing framework in the MVP one-shot — but the layer-by-layer build has manual verify steps at each stage. Automated tests should be added before Phase 2.

### Risk areas
- **TipTap + SvelteKit SSR** — TipTap is browser-only. Editor component must guard with `{#if browser}` or dynamic import to prevent "document is not defined" errors during server rendering.
- **better-sqlite3 native addon** — requires node-gyp build tools (python, make, g++). Usually painless but verify on target system.
- **Large .scriv imports** — tested with 31-item Talamus project. A novel with 500+ documents may need streaming/batching for the import pipeline.
- **Port clarity** — `localhost:5173` is SvelteKit dev server. Production via `adapter-node` defaults to port 3000. Both are local-only for MVP.

---

## Review History

- **v0.1** — Initial implementation plan (Feb 19, 2026)
- **v0.2** — Revised after Codex + Gemini review. Changes:
  - Added `last_snapshot_at` to documents schema for deterministic snapshot debounce (Codex)
  - FTS5 now explicitly indexes plain text, not raw HTML (Both)
  - FTS5 de-indexes on soft-delete, re-indexes on restore (Codex)
  - Defined tree reorder payload schema explicitly (Codex)
  - Documented atomic write error recovery and startup consistency check (Codex)
  - Decided TipTap core + thin Svelte wrapper over svelte-tiptap (Gemini)
  - Added SSR guard requirement for TipTap (Gemini)
  - Flag manuscript root folder during .scriv import for compile (Gemini)
  - Novel word count on library cards (Gemini)
  - Noted `importScriv(path)` signature for future upload swap (Gemini)
  - Sort-order renormalization deferred to Phase 2+ (Gemini)
  - Explicit "no permanent delete in MVP" (preservation-first)
  - Documented deferred schema fields (notes, status labels, server_version, content_hash)
  - Added port clarity note (Codex)

---

*Companion to `spec.md` v0.4. Implementation plan v0.2.*
