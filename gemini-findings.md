# Scriptorium Phase 1a — Code Review for Gemini

## Instructions

You are reviewing an implementation plan (`implementation.md`) for a SvelteKit web application: a preservation-first novel writing tool with a TipTap rich text editor, SQLite backend, binder tree, and full-text search.

**Your task:** Thoroughly review the implementation plan for design flaws, missing edge cases, security concerns, data integrity risks, and UX gaps. Record ALL findings in this file — do NOT modify any source code or the implementation plan.

**Focus:** The implementation plan adds a **snapshot browser** — a timeline UI for viewing, previewing, and restoring previous versions of documents. Review both the plan and the existing codebase it builds on.

---

## Project Overview

- **Framework:** SvelteKit (Svelte 5 with runes: `$state`, `$derived`, `$effect`, `$props`)
- **Database:** SQLite via better-sqlite3 (WAL mode, FTS5 full-text search)
- **Editor:** TipTap (ProseMirror-based)
- **Content storage:** HTML files on disk (SQLite stores metadata only)
- **Snapshots:** HTML files at `data/{novelId}/snapshots/{docId}/{timestamp}.html`
- **Styling:** CSS custom properties for theming (light + dark)

---

## Key Documents

| Document | Purpose |
|----------|---------|
| `implementation.md` | **PRIMARY REVIEW TARGET** — snapshot browser implementation plan |
| `spec.md` | Full application specification (v0.4) |

## Complete File Listing

### Source Files (`src/`)
| File | Purpose |
|------|---------|
| `app.html` | HTML shell with inline theme flash-prevention script |
| `app.d.ts` | TypeScript globals (App.Locals with db) |
| `hooks.server.ts` | Attaches SQLite db to every request via event.locals |
| `lib/index.ts` | Empty barrel file |
| `lib/types.ts` | Shared TypeScript interfaces (TreeNode, Snapshot, etc.) |
| `lib/components/Editor.svelte` | TipTap rich text editor with toolbar, search, spellcheck |
| `lib/server/db.ts` | SQLite setup, schema creation, singleton |
| `lib/server/files.ts` | Disk I/O helpers (atomic write, read, strip HTML, path validation) |
| `lib/server/validate.ts` | Security: path segment validation, snippet sanitization |
| `lib/server/tree-ops.ts` | Shared tree operations (cascade delete, FTS re-index) |
| `lib/server/import/scriv.ts` | Scrivener .scriv project importer |
| `routes/+layout.svelte` | Root layout with CSS custom properties, theme toggle |
| `routes/+page.svelte` | Library home page (novel grid, create, import, rename) |
| `routes/novels/[id]/+page.server.ts` | Server load: fetches novel + word count |
| `routes/novels/[id]/+page.svelte` | Novel workspace (sidebar binder + editor) |
| `routes/api/novels/+server.ts` | GET list, POST create novel |
| `routes/api/novels/[id]/+server.ts` | GET, PUT, DELETE novel |
| `routes/api/novels/[id]/tree/+server.ts` | GET full tree, PUT reorder/reparent |
| `routes/api/novels/[id]/tree/nodes/+server.ts` | POST create folder or document |
| `routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts` | DELETE (soft), PATCH (rename/restore) |
| `routes/api/documents/[id]/+server.ts` | GET content+metadata, PUT save |
| `routes/api/documents/[id]/snapshots/+server.ts` | GET list, POST manual snapshot |
| `routes/api/documents/[id]/snapshots/[snapId]/+server.ts` | GET snapshot content |
| `routes/api/search/+server.ts` | FTS5 full-text search |
| `routes/api/admin/import/+server.ts` | Import .scriv directory |

### Test Files (`tests/`)
| File | Purpose |
|------|---------|
| `helpers.ts` | Test utilities (in-memory DB, seed data) |
| `db.test.ts` | busy_timeout verification |
| `import.test.ts` | Import sort order + transaction safety |
| `tree-restore.test.ts` | FTS re-indexing on folder restore + novel soft-delete |
| `editor-save.test.ts` | Editor save reliability (keepalive, async switchDocument) |
| `theme-prefs.test.ts` | CSS variables, dark theme, flash prevention |
| `security.test.ts` | Path validation, XSS sanitization, deleted_at enforcement |
| `robustness.test.ts` | DB init, fsync, snapshot race, localStorage safety |
| `accessibility.test.ts` | aria-modal, aria-label, icon accessibility |

---

## Areas of Focus

### 1. Plan Completeness
- Does the plan cover all spec requirements for the snapshot browser?
- Are there any missing user flows or interactions?
- Is the component breakdown reasonable — too many files? too few?

### 2. Restore Safety
- Non-destructive guarantee: can any sequence of actions lead to data loss?
- What if the user restores, then restores again, then wants to get back to the original?
- Pre-restore snapshot: is the "snapshot current → overwrite → update metadata" sequence atomic enough?

### 3. UX Design
- Is the snapshot panel discoverable enough? Writer persona shouldn't need to think about versioning
- Preview mode: is it clear to the user they're looking at an old version vs the current document?
- Restore confirmation: is it reassuring enough ("nothing will be lost")?
- How does the panel interact with mobile layout?

### 4. Editor Integration
- Hiding vs destroying the editor during preview — any TipTap/ProseMirror gotchas?
- Auto-save flush before preview — race conditions?
- What happens if the user navigates to a different document while preview is open?

### 5. Performance Considerations
- Snapshot list pagination for documents with hundreds of snapshots
- Lazy loading of snapshot content (only fetch when clicked)
- Panel rendering performance with many entries

### 6. Security
- Snapshot content is HTML rendered with `{@html}` — is it sanitized?
- Content_path stored in DB — is this an absolute path? Could it be manipulated?

### 7. Existing Code Quality
- Any existing bugs or issues in the snapshot-related endpoints that would affect this feature?
- Are there any patterns in the existing code that the plan should follow more closely?

### 8. Testing Strategy
- Are the proposed tests comprehensive enough?
- Any missing edge cases that should be tested?
- Integration test considerations

---

## Severity Scale

- Critical: Data loss, security vulnerability, crash
- High: Functional bug affecting user workflows
- Medium: Edge case bug, performance issue, or maintainability concern
- Low: Style, naming, minor improvement
- Note: Observation, not necessarily a bug

---

## Findings

### 🔴 Critical: Distributed Transaction Risk in Restore
- **Section:** Layer 1: Restore Endpoint
- **Description:** The restore flow involves multiple file system writes (snapshotting current state and overwriting document) and SQLite updates. If the server crashes or an error occurs between these steps, the system could be left in an inconsistent state (e.g., a "pre-restore" snapshot exists but the document wasn't reverted, or the file was reverted but DB metadata like `word_count` or `updated_at` wasn't updated).
- **Suggested Fix:** Wrap all database operations in a single SQLite transaction. Perform file writes using the atomic pattern (temp file + rename) *before* committing the transaction. If a file write fails, the transaction can be rolled back. If the transaction commit fails, the files remain updated on disk (preserving content) but metadata may be stale—this is safer than the inverse.

### 🟠 Major: Search Index Leak in Soft-Deleted Novels
- **File:** `src/routes/api/search/+server.ts`
- **Description:** The FTS5 search query joins `documents` and `novels` but only checks if the document is deleted (`d.deleted_at IS NULL`). It does NOT check if the parent novel is deleted (`n.deleted_at IS NULL`). This causes search results from soft-deleted novels to appear in the global search.
- **Suggested Fix:** Add `AND n.deleted_at IS NULL` to the `WHERE` clause in the search endpoint.

### 🟠 Major: Potential Path Traversal in Snapshot Read
- **File:** `src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts`
- **Description:** The snapshot content endpoint reads from `snapshot.content_path` directly from the database. If the database is compromised or a malicious entry is inserted, this allows reading arbitrary files on the system.
- **Suggested Fix:** Instead of storing/trusting the full path in the DB, store only the timestamp or filename. Reconstruct the path on the server using `path.join(getDataRoot(), novelId, 'snapshots', docId, filename)` to ensure the read is restricted to the data directory.

### 🟡 Medium: Snapshot Ordering Collision
- **File:** `src/routes/api/documents/[id]/snapshots/+server.ts`
- **Description:** Snapshot listing uses `ORDER BY created_at DESC`. While `created_at` includes milliseconds, concurrent operations or clock jitter could result in identical timestamps, making the order non-deterministic. This affects the "Word Count Delta" calculation.
- **Suggested Fix:** Add a secondary sort key to the order clause, e.g., `ORDER BY created_at DESC, id DESC`.

### 🟡 Medium: Delta Calculation vs. Pagination
- **Section:** Layer 5: Performance Considerations
- **Description:** The plan suggests calculating word count deltas client-side from the sorted list. If pagination is implemented, the first item on page 2 will have no reference for its delta unless the client fetches an extra item or the server provides the previous word count.
- **Suggested Fix:** Either include the `previous_word_count` in the snapshot metadata returned by the server, or ensure the client always has the "next" item in the timeline to compute the delta.

### 🟡 Medium: Missing Transaction in Manual Snapshot
- **File:** `src/routes/api/documents/[id]/snapshots/+server.ts`
- **Description:** The `POST` endpoint for manual snapshots performs an `INSERT` into `snapshots` and an `UPDATE` on `documents` in two separate calls without a transaction. If the second call fails, `last_snapshot_at` will be incorrect.
- **Suggested Fix:** Wrap both DB operations in a `locals.db.transaction()`.

### 🔵 Low: Redundant Snapshot on Identical Restore
- **Section:** Layer 1: Restore Endpoint
- **Description:** The plan always creates a "pre-restore" snapshot. If a user restores a version that is identical to the current content (e.g., they accidentally clicked twice), a redundant snapshot is created.
- **Suggested Fix:** (Optional) Compare the snapshot content with the current document content and skip the restore/pre-snapshot if they are identical.

### 🔵 Note: SSR Safety in Editor
- **File:** `src/lib/components/Editor.svelte`
- **Description:** The spellcheck initialization correctly uses `typeof localStorage !== 'undefined'` to avoid errors during server-side rendering. This pattern should be maintained in any new UI components (like the Snapshot Panel) that access `localStorage`.
- **Severity:** Note

