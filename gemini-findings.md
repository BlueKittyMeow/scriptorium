# Scriptorium Phase 1b — Code Review for Gemini

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
- [x] Command injection in Pandoc invocation (execFile vs exec, argument construction)
- [x] Path traversal in file reads during compile
- [x] Input validation on format, configId, include_ids
- [x] XSS in assembled HTML (title, subtitle escaping)
- [x] Content-Disposition header injection

### 2. Data Integrity
- [x] Tree-walk correctness (sort order, deleted items, nested folders)
- [x] Compile config CRUD (FK constraints, JSON serialization of include_ids)
- [x] compile_include toggle atomicity
- [x] Race conditions during compile (concurrent saves)

### 3. Error Handling
- [x] Pandoc not installed / not on PATH
- [x] Pandoc conversion failures (corrupt HTML, timeout)
- [x] Empty novel / no included documents
- [x] Missing content files on disk
- [x] Network errors in CompileDialog fetch calls

### 4. Performance
- [x] Large novels (100+ documents) — full tree walk + file reads
- [x] Pandoc process lifecycle (timeout, memory limits)
- [x] CompileDialog reactivity (checkbox toggles triggering PATCH calls)

### 5. UX
- [x] CompileDialog usability (layout, responsiveness, feedback)
- [x] Error states shown to user
- [x] Loading/progress indicators during compile
- [x] Preview behavior (new tab vs inline)

---

## Findings

### Finding 1
- **Severity:** High
- **Category:** Logic Error / Performance
- **File:** `src/lib/server/compile/pandoc.ts`
- **Issue:** The `convertHtmlToFormat` function calls `execFileAsync('pandoc', args, ...)` BEFORE calling `spawnPandoc`. Since `execFile` is not provided with stdin, and Pandoc expects stdin when no input file is specified in `args`, this call will hang until the 60-second timeout and then fail. This makes the compile feature essentially non-functional or extremely slow and error-prone.
- **Suggested fix:** Remove the redundant `execFileAsync` call and use only `spawnPandoc` to perform the conversion.

### Finding 2
- **Severity:** Medium
- **Category:** Performance
- **File:** `src/lib/server/compile/tree-walk.ts`
- **Issue:** The `walkSorted` function performs recursive tree walking by filtering the entire `folders` and `documents` arrays at every level: `folders.filter(f => f.parent_id === parentId)`. In a novel with many documents, this results in O(N^2) complexity, which can cause significant delays during the "Export" or "Preview" operations.
- **Suggested fix:** Group folders and documents by `parent_id` once at the beginning of `collectCompileDocuments` (e.g., using a Map) to allow O(1) lookup during the walk.

### Finding 3
- **Severity:** Medium
- **Category:** Functional / UX
- **File:** `src/lib/components/CompileDialog.svelte`
- **Issue:** The implementation plan and the backend API (`/api/novels/[id]/compile/configs`) both support "Saved compile configurations," but the `CompileDialog` UI is missing any way to list, select, or save these configurations. Users have to manually toggle checkboxes every time they want to export a specific subset of documents.
- **Suggested fix:** Implement the configuration selector and "Save current as config" button in the `CompileDialog`.

### Finding 4
- **Severity:** Medium
- **Category:** Data Integrity
- **File:** `src/routes/api/novels/[id]/compile/configs/[configId]/+server.ts`
- **Issue:** In the `PUT` handler, the logic `includeIdsJson ?? null` combined with `COALESCE(?, include_ids)` makes it impossible to set `include_ids` back to `null` if it already has a value, because `null` tells SQLite to use the existing value.
- **Suggested fix:** Use a more explicit update query or handle the `null` case outside of `COALESCE` to allow clearing the `include_ids` field.

### Finding 5
- **Severity:** Low
- **Category:** Robustness
- **File:** `src/routes/api/novels/[id]/compile/+server.ts`
- **Issue:** `JSON.parse(config.include_ids)` is called without a try-catch block. If the database somehow ends up with invalid JSON in that column, the entire compile request will crash with a 500 error.
- **Suggested fix:** Wrap `JSON.parse` in a try-catch and provide a fallback or clear error message.
