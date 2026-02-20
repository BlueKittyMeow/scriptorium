# Scriptorium Phase 1b — Code Review for Codex

## Instructions

You are reviewing the **compile/export** implementation for a SvelteKit web application: a preservation-first novel writing tool with a TipTap rich text editor, SQLite backend, binder tree, and full-text search.

**Your task:** Thoroughly review the new compile/export code for design flaws, missing edge cases, security concerns, data integrity risks, and UX gaps. Record ALL findings in this file — do NOT modify any source code.

**Focus:** Phase 1b adds **compile/export via Pandoc** — tree-walk document collection, HTML assembly with title page, Pandoc conversion to docx/epub/pdf/markdown, saved compile configurations, and a CompileDialog UI. Review the new code and how it integrates with the existing codebase.

---

## Project Overview

- **Framework:** SvelteKit (Svelte 5 with runes: `$state`, `$derived`, `$effect`, `$props`)
- **Database:** SQLite via better-sqlite3 (WAL mode, FTS5 full-text search)
- **Editor:** TipTap (ProseMirror-based)
- **Content storage:** HTML files on disk (SQLite stores metadata only)
- **Snapshots:** HTML files at `data/{novelId}/snapshots/{docId}/{uuid}.html`
- **Styling:** CSS custom properties for theming (light + dark)
- **Compile:** Pandoc via `execFile` (not `exec`), wkhtmltopdf for PDF engine

---

## Key New Files (PRIMARY REVIEW TARGETS)

| File | Purpose |
|------|---------|
| `src/lib/server/compile/tree-walk.ts` | Collects documents in tree sort order, respects `compile_include` and `deleted_at` |
| `src/lib/server/compile/assemble.ts` | Assembles full HTML document with title page, chapter sections, styling |
| `src/lib/server/compile/pandoc.ts` | Pandoc wrapper: `execFile` for safety, stdin piping, wkhtmltopdf for PDF |
| `src/lib/server/compile/types.ts` | `CompileFormat`, `CompileDocument`, `CompileResult`, format config map |
| `src/routes/api/novels/[id]/compile/+server.ts` | POST — compile to docx/epub/pdf/markdown, returns binary download |
| `src/routes/api/novels/[id]/compile/preview/+server.ts` | GET — pure HTML preview (no Pandoc) |
| `src/routes/api/novels/[id]/compile/configs/+server.ts` | GET/POST — list and create compile configurations |
| `src/routes/api/novels/[id]/compile/configs/[configId]/+server.ts` | PUT/DELETE — update and delete compile configurations |
| `src/lib/components/CompileDialog.svelte` | Modal dialog: format selector, document checklist, preview/export |
| `tests/compile.test.ts` | 32 tests covering tree-walk, assemble, pandoc, endpoints, configs |

## Modified Files

| File | Change |
|------|--------|
| `src/lib/server/db.ts` | Added `compile_configs` table to schema |
| `src/lib/types.ts` | Added `CompileFormat` type and `CompileConfig` interface |
| `tests/helpers.ts` | Added `compile_configs` table to test schema |
| `src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts` | PATCH now supports `compile_include` toggle |
| `src/routes/novels/[id]/+page.svelte` | Compile button in sidebar + CompileDialog integration |

## Existing Files (for context)

| File | Purpose |
|------|---------|
| `spec.md` | Full application specification (v0.5) |
| `src/lib/server/files.ts` | Disk I/O: atomic write, readContentFile, stripHtml, countWords |
| `src/lib/server/validate.ts` | Path segment validation, snippet sanitization |
| `src/lib/server/tree-ops.ts` | Cascade delete/restore, FTS re-indexing |
| `src/routes/api/novels/[id]/tree/+server.ts` | Tree builder (GET — builds nested TreeNode[]) |
| `src/lib/components/Editor.svelte` | TipTap editor with toolbar, word count, save status |
| `src/lib/components/SnapshotPanel.svelte` | Snapshot timeline panel |

---

## Review Checklist

Please evaluate each area and record findings below:

### 1. Security
- [ ] Command injection in Pandoc invocation (execFile vs exec, argument construction)
- [ ] Path traversal in file reads during compile
- [ ] Input validation on format, configId, include_ids
- [ ] XSS in assembled HTML (title, subtitle escaping)
- [ ] Content-Disposition header injection

### 2. Data Integrity
- [ ] Tree-walk correctness (sort order, deleted items, nested folders)
- [ ] Compile config CRUD (FK constraints, JSON serialization of include_ids)
- [ ] compile_include toggle atomicity
- [ ] Race conditions during compile (concurrent saves)

### 3. Error Handling
- [ ] Pandoc not installed / not on PATH
- [ ] Pandoc conversion failures (corrupt HTML, timeout)
- [ ] Empty novel / no included documents
- [ ] Missing content files on disk
- [ ] Network errors in CompileDialog fetch calls

### 4. Performance
- [ ] Large novels (100+ documents) — full tree walk + file reads
- [ ] Pandoc process lifecycle (timeout, memory limits)
- [ ] CompileDialog reactivity (checkbox toggles triggering PATCH calls)

### 5. UX
- [ ] CompileDialog usability (layout, responsiveness, feedback)
- [ ] Error states shown to user
- [ ] Loading/progress indicators during compile
- [ ] Preview behavior (new tab vs inline)

---

## Findings

_Record your findings below. For each finding, include: severity (High/Medium/Low), category, file, description, and suggested fix._

### Finding 1
- **Severity:** Medium
- **Category:** Performance / Error Handling
- **File:** `src/lib/server/compile/pandoc.ts:31-43`
- **Issue:** `convertHtmlToFormat` runs Pandoc twice: first via `execFileAsync('pandoc', args, ...)` (without stdin) and then again via `spawnPandoc` with stdin. The first call is unused and can fail or waste time, doubling work on every compile and risking timeouts for large novels.
- **Suggested fix:** Remove the initial `execFileAsync` invocation and use only the stdin‑piped `spawnPandoc` path (or switch entirely to `spawn` with proper piping).

### Finding 2
- **Severity:** Medium
- **Category:** Error Handling / Performance
- **File:** `src/lib/server/compile/pandoc.ts:75-103`
- **Issue:** `spawnPandoc` passes `timeout: 60000` to `spawn`, but Node’s `spawn` options do not enforce timeouts. A hung Pandoc process will run indefinitely with no kill/cleanup.
- **Suggested fix:** Implement a manual timer that kills the process after the configured timeout and returns a clear error.

### Finding 3
- **Severity:** Medium
- **Category:** Security
- **File:** `src/lib/server/compile/assemble.ts:16-28` and `src/routes/api/novels/[id]/compile/preview/+server.ts`
- **Issue:** Compile preview serves raw document HTML directly. If a document contains unsafe HTML (e.g., `<script>`), previewing the compile output can execute it in the browser. This is a stored XSS vector, especially for imported or pasted content.
- **Suggested fix:** Sanitize compiled HTML before serving preview (or render via TipTap in read‑only mode with the editor’s schema), and consider a restrictive CSP header on the preview response.

### Finding 4
- **Severity:** Medium
- **Category:** Data Integrity / Error Handling
- **File:** `src/routes/api/novels/[id]/compile/+server.ts:21-35`
- **Issue:** `include_ids` is parsed from `compile_configs.include_ids` without validation. If the stored JSON is malformed or not an array, `JSON.parse` throws or `includeIds.includes` fails inside `collectCompileDocuments`, returning a 500.
- **Suggested fix:** Wrap `JSON.parse` in a try/catch and validate `include_ids` is an array of strings (else return 400 or ignore invalid values).

### Finding 5
- **Severity:** Medium
- **Category:** UX / Data Integrity
- **File:** `src/lib/components/CompileDialog.svelte:48-78, 70-78`
- **Issue:** `toggleCompileInclude` optimistically updates local state without checking response success, and `handleCompile` does not wait for pending PATCH requests. Users can click “Export” immediately after toggling, producing output that doesn’t match the checklist (or silently failing if the PATCH failed).
- **Suggested fix:** Track pending include‑toggle requests and disable compile/preview until they complete; handle failed PATCH responses with a visible error and rollback.

### Finding 6
- **Severity:** Medium
- **Category:** Performance
- **File:** `src/lib/server/compile/tree-walk.ts:48-69`
- **Issue:** `walkSorted` repeatedly filters `folders` and `documents` arrays at each recursion level, making the traversal O(n²) for large trees.
- **Suggested fix:** Pre-index children by `parent_id` into maps once, then traverse in O(n).

### Finding 7
- **Severity:** Low
- **Category:** Data Integrity / UX
- **File:** `src/lib/server/compile/assemble.ts:18-22`
- **Issue:** Missing content files are silently treated as empty strings; compilation succeeds but produces incomplete output with no warning.
- **Suggested fix:** Detect missing files during assembly and either surface a warning to the user or fail the compile with a clear error message listing the missing documents.

<!-- Add more findings as needed -->
