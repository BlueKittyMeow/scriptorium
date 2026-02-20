# Scriptorium Code Review — Gemini

## Instructions

You are reviewing **Scriptorium**, a preservation-first novel writing application built with SvelteKit (Svelte 5 with runes), TipTap/ProseMirror, and SQLite (better-sqlite3).

**Your task:** Perform a thorough code review of the entire codebase. Flag bugs, logic errors, race conditions, security issues, missing error handling, accessibility problems, and architectural concerns.

**Rules:**
- Record ALL findings in this file only — in the "Findings" section below
- Do NOT modify any source files
- Do NOT create any other files
- Be specific: include file paths, line numbers, and code snippets where relevant
- Categorize each finding by severity: 🔴 Critical, 🟠 Major, 🟡 Minor, 🔵 Nit
- If something looks intentional or is a known tradeoff, note it but don't over-flag

## Project Overview

- **Stack:** SvelteKit + adapter-node, Svelte 5 (runes: `$state`, `$derived`, `$effect`, `$props`), TipTap editor, better-sqlite3, SQLite FTS5
- **Purpose:** Novel manuscript management — import .scriv files, organize documents in a binder tree (folders + documents), rich text editing, full-text search, snapshots
- **Data:** SQLite DB with WAL mode, atomic file writes, soft-delete pattern throughout

## Files to Review

### Core Infrastructure
- `src/hooks.server.ts` — DB initialization hook
- `src/lib/server/db.ts` — Database setup, schema, migrations
- `src/lib/server/files.ts` — Atomic file operations
- `src/lib/types.ts` — Shared TypeScript types
- `src/app.d.ts` — SvelteKit type augmentation

### API Routes
- `src/routes/api/novels/+server.ts` — Novel CRUD (list, create)
- `src/routes/api/novels/[id]/+server.ts` — Novel CRUD (get, update, delete)
- `src/routes/api/novels/[id]/tree/+server.ts` — Binder tree (get tree, reorder nodes)
- `src/routes/api/novels/[id]/tree/nodes/+server.ts` — Create nodes (folders/documents)
- `src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts` — Node CRUD
- `src/routes/api/documents/[id]/+server.ts` — Document content operations
- `src/routes/api/documents/[id]/snapshots/+server.ts` — Snapshot list/create
- `src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts` — Individual snapshot
- `src/routes/api/search/+server.ts` — Full-text search with FTS5
- `src/routes/api/admin/import/+server.ts` — .scriv file import

### Import Logic
- `src/lib/server/import/scriv.ts` — Scrivener .scriv parsing and import

### UI / Pages
- `src/routes/+layout.svelte` — Root layout
- `src/routes/+page.svelte` — Library page (novel list)
- `src/routes/novels/[id]/+page.server.ts` — Novel workspace data loader
- `src/routes/novels/[id]/+page.svelte` — Novel workspace (binder tree, editor, search)
- `src/lib/components/Editor.svelte` — TipTap editor with search highlight, spellcheck, autosave

### Config
- `package.json`
- `svelte.config.js`
- `vite.config.ts`
- `tsconfig.json`

## Areas of Focus

1. **Race conditions** — autosave timing, document switching, search highlight lifecycle
2. **Data integrity** — SQL injection via string interpolation, soft-delete consistency, FTS sync
3. **Error handling** — unhandled promise rejections, missing try/catch, silent failures
4. **Security** — input validation, path traversal in import, XSS via HTML content
5. **Memory leaks** — event listeners, timers, editor lifecycle
6. **Svelte 5 patterns** — correct use of runes, effect cleanup, reactivity gotchas
7. **Accessibility** — ARIA roles, keyboard navigation, screen reader support
8. **Edge cases** — empty states, concurrent edits, large documents, special characters in search

---

## Findings

<!-- Record all findings below this line. Do not modify any other files. -->

✦ I've completed a thorough code review of the
  Scriptorium codebase. My findings, categorized
  by severity, are recorded below in accordance
  with your instructions.

  Findings


  🔴 Critical


   * Missing Transaction in Import Pipeline
     (`src/lib/server/import/scriv.ts`): The
     importScriv function iterates through the
     binder tree and performs multiple INSERT
     operations into the novels, folders,
     documents, and documents_fts tables, but it
     does not wrap these in a SQLite transaction.
     A failure mid-import will result in a
     corrupted, partially-imported novel.
     Furthermore, row-by-row inserts without a
     transaction are significantly slower for
     large Scrivener projects.
   * Cyclic Move Vulnerability in Tree Sync
     (`src/routes/api/novels/[id]/tree/+server.ts`
     ): The PUT endpoint for reordering nodes does
     not verify that a folder isn't being moved
     into one of its own descendants. If a user
     (or a race condition in a future sync
     implementation) performs such a move, the
     affected nodes will become an isolated cycle,
     disappearing from the UI but remaining as
     orphans in the database.
   * Broken FTS Re-indexing on Restore
     (`src/routes/api/novels/[id]/tree/nodes/[node
     Id]/+server.ts`): When a folder is restored
     from the trash via PATCH, the restoreChildFts
     helper clears the deleted_at flag on child
     documents but does not re-insert them into
     the documents_fts virtual table. These
     documents will remain missing from search
     results until they are manually edited and
     saved again.
   * Missing `updated_at` Update on Node Restore
     (`src/routes/api/novels/[id]/tree/nodes/[node
     Id]/+server.ts`): The PATCH endpoint for
     restoring nodes clears the deleted_at
     timestamp but fails to update the updated_at
     field. This will break any future sync
     protocols that rely on updated_at to detect
     changes made since the last sync.
   * FTS Query Injection Risk
     (`src/routes/api/search/+server.ts`): The
     prefix-search construction tokens.map(t =>
     "${t.replace(/"/g, '""')}"*").join(' ') is
     vulnerable to malformed FTS5 query syntax.
     While it handles double quotes, characters
     like *, -, or : outside of quotes can break
     the query syntax and cause the search to
     crash or return incorrect results.
   * Float Precision Exhaustion in Reordering
     (`src/routes/novels/[id]/+page.svelte`): The
     handleDrop function uses a midpoint
     calculation strategy: (filtered[idx -
     1].sort_order + filtered[idx].sort_order) /
     2. While fine for occasional moves,
     repeatedly moving nodes between the same two
     neighbors will eventually exceed the
     precision limits of a 64-bit float, leading
     to collisions where multiple nodes share the
     exact same sort_order.
   * Performance Bottleneck in Trash Section
     (`src/routes/novels/[id]/+page.svelte`): The
     trashedItems derived state calls
     collectTrashed(tree), which recursively
     iterates through the entire document tree on
     every change to the tree state. For large
     novels (500+ documents/folders), this will
     cause noticeable UI lag during drag-and-drop
     or content saving.

  🟠 Major


   * Cross-Novel Node Injection
     (`src/routes/api/novels/[id]/tree/+server.ts`
     ): The tree PUT endpoint does not verify that
     the new_parent_id belongs to the same
     novel_id. An attacker (or a client-side bug)
     could move nodes across novel boundaries or
     attach them to invalid parents.
   * Folder Content Import Logic Error
     (`src/lib/server/import/scriv.ts`): The
     tryImportContent helper is called for both
     folders and documents. If a folder contains
     RTF text in Scrivener, the code attempts to
     update the documents table using the folder's
     UUID. This will fail to update the folder's
     metadata or, worse, update a document with a
     colliding ID if one exists.
   * Non-Atomic Snapshot Creation
     (`src/routes/api/documents/[id]/+server.ts`):
     In the document PUT endpoint, the
     writeSnapshotFile (file system) call is mixed
     with the SQLite transaction. If the database
     commit fails, the snapshot file remains on
     disk but is orphaned from the database
     metadata. Conversely, if the file write fails
     (e.g., disk full), the DB update might still
     proceed if the error isn't caught correctly
     within the transaction block.
   * Stale Snapshot Logic
     (`src/routes/api/documents/[id]/+server.ts`):
     The shouldSnapshot check uses
     doc.last_snapshot_at fetched before the
     transaction starts. In a multi-user or
     multi-device scenario, this value could be
     stale, leading to redundant or missing
     snapshots.
   * Potential Data Loss on Navigation
     (`src/lib/components/Editor.svelte`): The
     onDestroy hook calls onsave to preserve the
     final state, but since it doesn't (and
     cannot) await the async fetch call, the
     browser may terminate the request before it
     completes if the user is navigating away or
     closing the tab.
   * Permanent Search Loss on Novel Delete
     (`src/routes/api/novels/[id]/+server.ts`):
     The DELETE endpoint for novels hard-deletes
     FTS entries from documents_fts. Since the
     novel itself is only soft-deleted, restoring
     the novel later will result in it being
     completely unsearchable until every document
     is manually re-saved.
   * Import Sort Order Collisions
     (`src/lib/server/import/scriv.ts`): The
     root-level items in the importScriv loop are
     all assigned a sort_order of 1.0. This causes
     immediate collisions for all top-level binder
  🟡 Minor


   * Partial Update Limitation
     (`src/routes/api/novels/[id]/+server.ts`):
     The use of COALESCE in the PUT endpoint
     prevents users from clearing optional fields
     like subtitle by setting them to null.
   * Redundant Library Re-fetches
     (`src/routes/+page.svelte`): Operations like
     renameNovel trigger a full re-fetch of the
     entire novel list instead of performing a
     local optimistic update to the Svelte $state.
   * Missing Creation Validation
     (`src/routes/api/novels/[id]/tree/nodes/+serv
     er.ts`): The node creation endpoint does not
     verify that the provided parent_id belongs to
     the target novel.
   * Duplicate Word Count Logic: The word count
     calculation is duplicated in
     src/lib/server/files.ts and
     src/lib/components/Editor.svelte. While
     necessary for the client/server split, they
     should be kept strictly in sync to avoid
     "word count jump" when saving.
   * Modal Accessibility: Modals in +page.svelte
     and novels/[id]/+page.svelte lack
     aria-modal="true", aria-labelledby, and
     proper focus-trapping logic, making them
     difficult for screen reader users to
     navigate.

  🔵 Nit


   * Snapshot Filenames: Filenames like
     2026-02-19T22-00-00-000Z.html are generated
     using replace(/[:.]/g, '-'). While
     functional, using a Unix timestamp or a more
     standard ISO format might be cleaner.
   * `stripHtml` Simplicity: The current
     regex-based stripHtml in files.ts is
     sufficient for plain-text word counts but may
     leave artifacts from complex nested HTML or
     edge cases. For a "preservation-first" app, a
     more robust parser might eventually be
     needed.
