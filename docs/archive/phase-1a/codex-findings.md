# Scriptorium Phase 1a — Code Review for Codex

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

### 1. Restore Endpoint Design
- Is the restore flow truly non-destructive? Any edge case where content could be lost?
- Race conditions: what if two restores happen simultaneously?
- What if the snapshot file is missing from disk but the DB record exists?
- Should the restore be wrapped in a transaction?
- Does the plan account for updating `last_snapshot_at` after creating the pre-restore snapshot?

### 2. Data Integrity
- FTS index consistency after restore
- Snapshot content_path correctness (are we storing absolute or relative paths?)
- What happens if restore is called on a document with unsaved editor changes?

### 3. UI State Management
- Editor state preservation during snapshot preview
- Auto-save behavior while preview is shown
- What happens if a new autosave snapshot arrives while the panel is open?

### 4. Security
- Snapshot content rendered as HTML — XSS vector?
- Path validation on snapshot ID parameters
- Authorization: should snapshot access require the document to be non-deleted?

### 5. Error Handling
- Network failure during restore
- Disk full during pre-restore snapshot write
- Concurrent edits from multiple tabs

### 6. Accessibility
- Keyboard navigation in snapshot timeline
- Screen reader support for snapshot entries
- Focus management when entering/exiting preview mode

### 7. Performance
- Large snapshot lists (documents edited over months)
- Snapshot content loading latency
- Memory usage when previewing large documents

---

## Severity Scale

- Critical: Data loss, security vulnerability, crash
- High: Functional bug affecting user workflows
- Medium: Edge case bug, performance issue, or maintainability concern
- Low: Style, naming, minor improvement
- Note: Observation, not necessarily a bug

---

## Findings

*(Record your findings below. For each finding, include: severity, relevant section of the plan or file, description, and suggested fix.)*

1. Severity: High. Section: `implementation.md` Layer 3 “Preview mode”. Description: The plan says the Editor is “not destroyed — just hidden with `{#if !previewingSnapshot}`”, but a Svelte `{#if}` *does* destroy the component. That will drop unsaved edits and reset editor state when entering preview. Suggested fix: keep the Editor mounted and hide it via CSS (or `aria-hidden` + `inert`) while preview is active, or move preview into an overlay so the editor remains alive.
2. Severity: High. Section: `implementation.md` “Snapshot preview” (rendered as HTML). Description: Previewing snapshot HTML in a read‑only container risks XSS if imported or user‑pasted HTML contains unsafe tags/attrs; the plan doesn’t require sanitization. Suggested fix: sanitize snapshot HTML before rendering, or render via TipTap in read‑only mode using the same schema, avoiding `{@html}`.
3. Severity: Medium. Section: `implementation.md` “Preview mode” and “Interaction flow”. Description: Autosave is still running in `Editor.svelte`; if preview mode opens with unsaved changes, the autosave timer can fire while preview is open or right after restore, overwriting restored content or creating extra snapshots. The plan only says “flush explicitly” but doesn’t specify pausing autosave. Suggested fix: on entering preview, clear pending save timers, await a final save, and pause autosave until preview is closed; also block restore if a save is in flight.
4. Severity: Medium. Section: `implementation.md` Layer 1 “Restore endpoint”. Description: The plan doesn’t specify transaction boundaries or ordering for file I/O vs DB/FTS updates. A failure between steps can leave a pre‑restore snapshot row without file, or update DB without file content. Suggested fix: read snapshot file first; write pre‑restore snapshot file; then perform a DB transaction to insert the pre‑restore snapshot row + update document metadata + FTS. Only after the transaction succeeds should you overwrite the document file (or vice‑versa, but ensure you can roll forward/recover).
5. Severity: Medium. Section: `implementation.md` Layer 1 “Snapshot the current state” (timestamp filenames). Description: Snapshot filenames are derived from timestamps (`now.replace(...)`), which can collide if two snapshots are created in the same millisecond (autosave + pre‑restore, or multi‑tab). Collisions will overwrite snapshot files. Suggested fix: use the snapshot UUID in the filename (or add a random suffix) and store `created_at` separately.
6. Severity: Medium. Section: `implementation.md` Layer 2 “Snapshot list”. Description: The plan fetches the full snapshot list every time the panel opens, with no pagination or virtualized list. For long‑running documents this can be hundreds/thousands of rows and hurt UI performance. Suggested fix: add pagination (`limit/offset`), infinite scroll, or lazy loading/virtualization.
7. Severity: Medium. Section: Existing code `src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts`. Description: Snapshot content reads do not verify the parent document is not soft‑deleted; only the list endpoint enforces `deleted_at IS NULL`. Direct access to deleted document snapshots is still possible. Suggested fix: join against `documents` and reject if `deleted_at` is set, matching the list/restore rules.
8. Severity: Low. Section: Existing code `src/lib/types.ts` vs snapshot list endpoint. Description: `Snapshot` type includes `content_path`, but `GET /api/documents/:id/snapshots` does not return it. The new UI will likely use this type and either lie to TS or cast to `any`. Suggested fix: make `content_path` optional or introduce a `SnapshotListItem` type that matches the list endpoint shape.
9. Severity: Low. Section: `implementation.md` “Word count delta”. Description: The delta is computed from a list sorted by `created_at DESC`, but the plan doesn’t specify whether the delta is against the previous *older* snapshot. Using the previous item in a descending list will invert signs. Suggested fix: compute deltas against the next older snapshot (or compute deltas on an ascending copy of the list).
