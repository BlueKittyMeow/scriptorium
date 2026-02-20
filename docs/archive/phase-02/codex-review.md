# Scriptorium — Code Review for Codex

## Instructions

You are reviewing a SvelteKit web application: a preservation-first novel writing tool with a TipTap rich text editor, SQLite backend, binder tree, and full-text search.

**Your task:** Thoroughly review the codebase for bugs, security issues, logic errors, performance concerns, and code quality problems. Record ALL findings in this file — do NOT modify any source code.

**Focus on the most recent changes:** dark mode / CSS custom properties / persistent preferences. But also review the full codebase for anything that was missed in the previous review round.

---

## Project Overview

- **Framework:** SvelteKit (Svelte 5 with runes: `$state`, `$derived`, `$effect`, `$props`)
- **Database:** SQLite via better-sqlite3 (WAL mode, FTS5 full-text search)
- **Editor:** TipTap (ProseMirror-based)
- **Content storage:** HTML files on disk (SQLite stores metadata only)
- **Styling:** CSS custom properties for theming (light + dark)
- **Preferences:** localStorage for theme and spellcheck

---

## Complete File Listing

### Source Files (`src/`)
| File | Purpose |
|------|---------|
| `app.html` | HTML shell with inline theme flash-prevention script |
| `app.d.ts` | TypeScript globals (App.Locals with db) |
| `hooks.server.ts` | Attaches SQLite db to every request via event.locals |
| `lib/index.ts` | Empty barrel file |
| `lib/types.ts` | Shared TypeScript interfaces (TreeNode, etc.) |
| `lib/components/Editor.svelte` | TipTap rich text editor with toolbar, search, spellcheck |
| `lib/server/db.ts` | SQLite setup, schema creation, singleton |
| `lib/server/files.ts` | Disk I/O helpers (atomic write, read, strip HTML) |
| `lib/server/tree-ops.ts` | Shared tree operations (cascade delete, FTS re-index, soft-delete) |
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
| `theme-prefs.test.ts` | CSS variables, dark theme, flash prevention, spellcheck persistence |

---

## Areas of Focus

### 1. Dark Mode / Theming
- CSS custom property completeness — any missed hardcoded colors?
- Dark theme color choices — contrast, readability, accessibility
- Flash-prevention script correctness
- Theme toggle cycle logic
- `prefers-color-scheme` listener behavior

### 2. localStorage Usage
- Spellcheck persistence — SSR safety (typeof localStorage check)
- Theme persistence — sync between app.html script and layout component
- Edge cases: localStorage disabled, private browsing, quota exceeded

### 3. Security
- SQL injection vectors (parameterized queries?)
- Path traversal in file operations
- XSS in user content
- Input validation on API endpoints

### 4. Data Integrity
- Atomic write correctness
- FTS index consistency with document lifecycle
- Soft-delete / restore completeness
- Snapshot creation logic

### 5. Error Handling
- Uncaught promise rejections
- Missing error boundaries
- API endpoints returning appropriate status codes

### 6. Performance
- Unnecessary re-renders in Svelte 5
- Database query efficiency
- Large document handling

### 7. Accessibility
- Keyboard navigation
- ARIA attributes
- Screen reader compatibility
- Color contrast in both themes

### 8. Code Quality
- TypeScript strictness
- Dead code
- Naming consistency
- Missing type annotations

---

## Severity Scale

- Critical: Data loss, security vulnerability, crash
- High: Functional bug affecting user workflows
- Medium: Edge case bug, performance issue, or maintainability concern
- Low: Style, naming, minor improvement
- Note: Observation, not necessarily a bug

---

## Findings

*(Record your findings below. For each finding, include: severity, file, line number(s), description, and suggested fix.)*

1. Severity: High. File: `src/lib/server/db.ts:17-30`. Description: DB initialization performs `mkdirSync`, opens the database, and runs `exec(SCHEMA)` without any try/catch, so an invalid `DATA_ROOT` or schema failure throws during request handling and bricks the app for all subsequent requests. Snippet: `fs.mkdirSync(...); _db = new Database(dbPath); _db.exec(SCHEMA);`. Suggested fix: wrap init in try/catch and fail fast at startup (or surface a clear 500 with context) rather than letting uncaught exceptions kill the process.
2. Severity: High. File: `src/lib/server/files.ts:25-34`. Description: `novelId`, `docId`, and `timestamp` are used directly in `path.join` when building document/snapshot paths, so `../` or path separators can escape `DATA_ROOT` and overwrite arbitrary files. Snippet: `path.join(getDataRoot(), novelId, 'docs', \`\${docId}.html\`)`. Suggested fix: strictly validate IDs (UUID/whitelist) and/or `path.resolve` + prefix check to ensure paths stay under `DATA_ROOT`.
3. Severity: Medium. File: `src/lib/server/files.ts:36-47`. Description: The atomic write helper renames the temp file but never fsyncs the parent directory, so a crash can lose the rename even though the file was fsynced. Snippet: `fs.renameSync(tmpPath, filePath)`. Suggested fix: open the parent directory and `fs.fsyncSync` it after rename to make the update durable.
4. Severity: High. File: `src/routes/novels/[id]/+page.svelte:398-403`. Description: Search results render `{@html result.snippet}` directly, allowing stored XSS if document content contains HTML/JS that is reflected in snippets. Snippet: `{@html result.snippet}`. Suggested fix: treat snippets as plain text (escape) or sanitize server-side before returning.
5. Severity: Medium. File: `src/lib/components/Editor.svelte:72-87` and `src/lib/components/Editor.svelte:118-129`. Description: If an autosave is in-flight (`saveStatus === 'saving'`) and the component unmounts, `onDestroy` does not use `keepalive` or await the in-flight request, so edits can be dropped when navigating away. Snippet: `if (saveStatus === 'unsaved') { fetch(..., { keepalive: true }) }`. Suggested fix: track the active save promise and await/keepalive on destroy when status is `'saving'` or `'unsaved'`.
6. Severity: Medium. File: `src/routes/novels/[id]/+page.svelte:461-476`. Description: The “New item” modal lacks `aria-modal="true"` and focus trapping, so keyboard users can tab into background content. Snippet: `<div role="dialog" tabindex="-1">`. Suggested fix: add `aria-modal="true"`, trap focus, and restore focus to the triggering element on close.
7. Severity: High. File: `src/routes/api/documents/[id]/+server.ts:6`. Description: Document GET/PUT selects by `id` only and ignores `deleted_at`, so trashed documents can still be read and updated. Snippet: `SELECT * FROM documents WHERE id = ?`. Suggested fix: add `AND deleted_at IS NULL` and reject writes to deleted rows.
8. Severity: Medium. File: `src/routes/api/documents/[id]/snapshots/+server.ts:6`. Description: Snapshot list/create selects the document without `deleted_at` filtering, allowing snapshot access/creation for trashed documents. Snippet: `SELECT * FROM documents WHERE id = ?`. Suggested fix: enforce `deleted_at IS NULL` for all snapshot endpoints.
9. Severity: Medium. File: `src/routes/api/novels/[id]/tree/+server.ts:10`. Description: Tree query loads all folders/documents without filtering `deleted_at`, so trashed nodes are returned in the binder payload and can be reordered. Snippet: `SELECT * FROM folders WHERE novel_id = ?`. Suggested fix: filter out deleted rows or return them in a separate “trash” section.
10. Severity: Medium. File: `src/routes/api/documents/[id]/+server.ts:31`. Description: Snapshot timing is computed from a stale `doc.last_snapshot_at` before the transaction, so concurrent saves can both pass the 2‑minute guard and create duplicate snapshots. Snippet: `const shouldSnapshot = !doc.last_snapshot_at || ...`. Suggested fix: recheck `last_snapshot_at` inside the transaction or use an `UPDATE ... WHERE last_snapshot_at < ?` guard.
11. Severity: High. File: `src/lib/server/import/scriv.ts:239`. Description: Importer uses binder IDs directly in `path.join` for `scrivId.rtf` and `{scrivId}/content.rtf`, allowing path traversal (or symlink escape) when a crafted `.scrivx` provides `../` segments. Snippet: `path.join(docsDir, \`\${scrivId}.rtf\`)`. Suggested fix: normalize/validate IDs and reject any resolved path that does not stay under `docsDir`.

