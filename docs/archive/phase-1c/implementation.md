# Phase 1c: Batch Import

## Motivation

Scriptorium's existing import handles one `.scriv` file at a time — the user types a full path, clicks Import, sees a report, then repeats for the next project. If you're migrating a library of 10-15 novels from Scrivener, this becomes tedious fast. Batch import eliminates that friction: point at a directory, see everything Scrivener-shaped inside it, pick what you want, import it all.

## User Story

Lara has a `~/Writing/` directory containing a dozen `.scriv` projects. She opens Scriptorium, clicks "Import .scriv", and pastes `~/Writing`. Scriptorium scans the directory recursively, finds all 12 `.scriv` bundles, and shows them as a checklist with names and sizes. Three are old abandoned drafts — she unchecks those. She clicks "Import 9 projects" and watches a progress indicator tick through each one. When it finishes, she sees an aggregate report: 9 imported, totals for documents/folders/words, and any warnings. She can open any of them directly from the results.

The existing single-file import flow is unchanged. If she types a path ending in `.scriv`, it imports that one file directly — same as before.

## Design Decisions

### Auto-detect mode from path
One input field, two behaviors:
- Path ends in `.scriv` → single import (existing flow, unchanged)
- Path is a regular directory → scan for `.scriv` bundles → show selectable list

This is simpler than two separate buttons/modals and feels natural.

### Async recursive scan with depth limit
Scan recursively (`.scriv` bundles can be nested in subdirectories) using `fs.promises.readdir` to avoid blocking the Node.js event loop. Cap depth at 5 levels. Ignore hidden directories (`.` prefix) and common non-project dirs (`node_modules`, `.git`). Symlinks are naturally skipped — `dirent.isDirectory()` from `withFileTypes` returns `false` for symlinks, so no cycle-detection is needed.

### Safe root boundary
The scan path must resolve (via `fs.realpathSync`) to somewhere under the user's home directory (`os.homedir()`). This prevents scanning system directories (`/etc`, `/proc`, `/sys`) and blocks symlink-based escapes. A simple prefix check after realpath resolution is sufficient — no config variable needed.

### Sequential import, not parallel
Import projects one at a time. Each `importScriv()` call does DB writes, file I/O, and RTF conversion — parallelizing would complicate error handling and could thrash the disk. Sequential is fast enough for local use (a typical .scriv imports in under a second).

### Error isolation
Each project imports independently. If project 3 of 9 fails, projects 1-2 are already committed and projects 4-9 still proceed. The aggregate report clearly shows which succeeded and which failed.

### Duplicate detection (warn, don't block)
Before importing, check existing novel titles against the scan results. Flag matches as "possibly already imported" in the UI. Don't block — the user may genuinely want to re-import (e.g., updated .scriv file).

### No merge/concatenation
Joining multiple `.scriv` files into one novel is architecturally complex (tree merging, sort-order conflicts, duplicate folders) and niche. Out of scope. Each `.scriv` becomes its own novel. If the user wants to combine later, they can drag documents between novels (future feature).

## API Design

### `POST /api/admin/import/scan`

Scans a directory for `.scriv` bundles.

**Request:**
```json
{
  "path": "/home/lara/Writing"
}
```

**Response (200):**
```json
{
  "directory": "/home/lara/Writing",
  "projects": [
    {
      "path": "/home/lara/Writing/Tigrenache.scriv",
      "name": "Tigrenache",
      "existingNovelTitle": null
    },
    {
      "path": "/home/lara/Writing/Subdir/OldDraft.scriv",
      "name": "OldDraft",
      "existingNovelTitle": "OldDraft"
    }
  ]
}
```

- `name`: derived from the `.scriv` directory name (same logic as existing import)
- `existingNovelTitle`: if a non-deleted novel with a matching title already exists, its title is returned here as a duplicate warning. `null` means no match.
- Returns 400 if path doesn't exist, isn't a directory, or contains no `.scriv` bundles.

**Implementation notes:**
- Use `fs.promises.readdir` with `{ withFileTypes: true }` for async recursive traversal (non-blocking)
- `dirent.isDirectory()` naturally skips symlinks (no explicit symlink handling needed)
- Check name ending in `.scriv` for candidates
- Skip hidden dirs (name starts with `.`), `node_modules`, `__pycache__`
- Max depth: 5 levels
- Validate each `.scriv` dir actually contains a `.scrivx` file (skip empty/corrupt ones)
- Path safety: `fs.realpathSync()` the input, reject if not under `os.homedir()`
- Validate the resolved path `statSync().isDirectory()` — reject files and broken paths with 400

### `POST /api/admin/import/batch`

Imports multiple `.scriv` projects sequentially.

**Request:**
```json
{
  "paths": [
    "/home/lara/Writing/Tigrenache.scriv",
    "/home/lara/Writing/TumultAndTempest.scriv"
  ]
}
```

**Response (200):**
```json
{
  "results": [
    {
      "path": "/home/lara/Writing/Tigrenache.scriv",
      "novel_id": "abc-123",
      "novel_title": "Tigrenache",
      "docs_imported": 47,
      "folders_created": 8,
      "files_skipped": 2,
      "total_word_count": 52340,
      "errors": [],
      "warnings": ["Skipped media file: cover.png"]
    },
    {
      "path": "/home/lara/Writing/TumultAndTempest.scriv",
      "novel_id": "def-456",
      "novel_title": "TumultAndTempest",
      "docs_imported": 32,
      "folders_created": 5,
      "files_skipped": 0,
      "total_word_count": 38100,
      "errors": [],
      "warnings": []
    }
  ],
  "summary": {
    "total": 2,
    "succeeded": 2,
    "failed": 0,
    "total_docs": 79,
    "total_folders": 13,
    "total_words": 90440
  }
}
```

**Error case — partial failure:**
```json
{
  "results": [
    { "path": "...", "novel_title": "Good", "docs_imported": 10, "errors": [] },
    { "path": "...", "novel_title": "Bad", "docs_imported": 0, "errors": ["Import aborted: corrupt .scrivx"] }
  ],
  "summary": { "total": 2, "succeeded": 1, "failed": 1, "total_docs": 10, "total_folders": 3, "total_words": 8200 }
}
```

**Implementation notes:**
- No pre-validation pass — validate each path inline (exists? isDirectory?) and include failures in `results`
- Loop through paths, call existing `importScriv(db, path)` for each
- Wrap each call in try/catch — never let one failure abort the batch
- A path that doesn't exist or isn't a directory gets a result entry with `errors: ["Path does not exist"]` / `"Path is not a directory"`, zero counts, and no `novel_id`
- Build summary from accumulated results
- Always returns 200 (the response body tells you what succeeded/failed)
- Returns 400 only for request-level validation (empty paths array, non-array, etc.)

### Existing `POST /api/admin/import` — unchanged

Single-file import stays exactly as-is. The batch UI calls `/import/batch` instead.

## Types

```typescript
// New/modified types in src/lib/types.ts

// Existing ImportReport gains total_word_count
// (computed by summing document word counts from DB after import completes)
export interface ImportReport {
  novel_id: string;
  novel_title: string;
  docs_imported: number;
  folders_created: number;
  files_skipped: number;
  total_word_count: number;  // NEW — sum of all imported documents' word_count
  errors: string[];
  warnings: string[];
}

export interface ScrivProject {
  path: string;
  name: string;
  existingNovelTitle: string | null;
}

export interface ScanResult {
  directory: string;
  projects: ScrivProject[];
}

export interface BatchImportResult {
  results: (ImportReport & { path: string })[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    total_docs: number;
    total_folders: number;
    total_words: number;
  };
}
```

## UI Changes

### Import Modal Rework

The existing import modal in `+page.svelte` gets extended with a two-phase flow:

**Phase 1 — Path Entry (same as before):**
- Text input for path
- If path ends in `.scriv` → "Import" button (existing single-file flow)
- If path is any other directory → "Scan" button appears instead

**Phase 2 — Batch Selection (new):**
- After scan completes, the modal expands to show:
  - Checklist of found `.scriv` projects (all checked by default)
  - Each row: checkbox, project name, relative path
  - Duplicate warnings: amber badge "Already imported?" next to matches
  - "Select All" / "Deselect All" toggle
  - "Import N projects" button (N updates live with checkbox changes)

**Phase 3 — Batch Progress (new):**
- Progress bar or counter: "Importing 3 of 9..."
- Current project name shown
- Cannot cancel mid-batch (imports are fast and each is atomic)
- Disable close/cancel while importing

**Phase 4 — Aggregate Report (new):**
- Summary line: "9 projects imported (47 documents, 12 folders, 90k words)"
- Failed projects shown in red with error messages
- Expandable per-project details (docs, folders, warnings)
- "Open" button next to each successfully imported novel
- "Done" button to close modal and refresh library

### State Machine

```
IDLE → PATH_ENTERED → (is .scriv?) → IMPORTING_SINGLE → REPORT_SINGLE
                    → (is dir?)    → SCANNING → PROJECT_LIST → IMPORTING_BATCH → REPORT_BATCH
```

The modal renders different content based on the current state. This is cleaner than a tangle of boolean flags.

**Modal lifecycle:** All state resets to `IDLE` when the modal opens (not when it closes). This prevents stale scan results or import reports from lingering if the modal was dismissed mid-flow. If a scan fetch is in flight when the modal closes, the response is ignored (guard on a generation counter or `AbortController`).

### Visual Design

The modal width increases slightly for batch mode (from `max-width: 500px` to `max-width: 600px`) to accommodate the project list. The checklist uses the same visual language as the CompileDialog document checklist — checkboxes, labels, subtle metadata.

## Server-Side: Scan Logic

New file: `src/lib/server/import/scan.ts`

```typescript
export interface ScanOptions {
  maxDepth?: number;       // default: 5
  skipHidden?: boolean;    // default: true
}

export async function scanForScrivProjects(
  directory: string,
  options?: ScanOptions
): Promise<{ path: string; name: string }[]>
```

This is a pure async function (no DB access) that recursively walks a directory looking for `.scriv` bundles. Uses `fs.promises.readdir` to avoid blocking the event loop. The API endpoint calls this, then cross-references results against the DB for duplicate detection.

**Path safety:**
- `fs.realpathSync()` the input to resolve symlinks and normalize
- Verify the resolved path is under `os.homedir()` (prefix check) — rejects system dirs, symlink escapes
- Verify `statSync().isDirectory()` — reject files and broken paths with clean error

**Symlink handling:**
- `readdir` with `{ withFileTypes: true }` + `dirent.isDirectory()` naturally returns `false` for symlinks
- No explicit symlink logic needed — symlinked directories are simply not traversed
- This prevents symlink cycles without needing a visited-set

**Validation per candidate:**
- Each `.scriv` candidate must contain at least one `.scrivx` file to be valid (checked via `readdir` on the `.scriv` dir)

**Skip list:**
- Hidden directories (`.` prefix)
- `node_modules`, `__pycache__`, `.git`, `.svn`, `Trash`, `.Trash`

## Test Plan

### Red phase — failing tests first

**Scan logic tests (DB-free, unit tests):**
1. `scan finds .scriv directories in a flat directory` — create temp dir with 3 .scriv bundles, verify all found
2. `scan finds .scriv in nested subdirectories` — 2 levels deep, verify recursive discovery
3. `scan skips hidden directories` — .scriv inside `.backup/` not found
4. `scan respects max depth` — .scriv at depth 6 not found with maxDepth=5
5. `scan skips .scriv without .scrivx file` — empty .scriv dir filtered out
6. `scan returns empty array for directory with no projects` — no false positives
7. `scan skips symlinked directories` — symlink to .scriv bundle not followed (if platform supports symlinks)

**Batch import tests (DB-level, use test helper):**
8. `batch import imports multiple projects` — 2 .scriv bundles → 2 novels in DB
9. `batch import isolates errors` — 1 good + 1 bad .scriv → 1 novel imported, 1 error in results
10. `batch import returns correct summary totals` — verify aggregation math (docs, folders, words)
11. `batch import handles non-directory path` — file path in batch → error in results, not a thrown exception
12. `batch import handles nonexistent path` — missing path in batch → error in results, other imports proceed

**API source-scan tests:**
13. `scan endpoint validates path is a directory` — source contains isDirectory or statSync check
14. `scan endpoint enforces homedir boundary` — source contains os.homedir or realpath check
15. `batch endpoint validates paths array` — source contains Array.isArray check
16. `batch endpoint calls importScriv for each path` — source contains loop + importScriv

**Duplicate detection test:**
17. `scan endpoint flags existing novels with matching titles` — import one novel, scan again, verify existingNovelTitle populated

## Implementation Order

Following the project's red-green TDD convention:

1. **Types** — Add `ScrivProject`, `ScanResult`, `BatchImportResult` to `src/lib/types.ts`
2. **Tests (RED)** — Write all 17 failing tests in `tests/batch-import.test.ts`
3. **Scan logic** — `src/lib/server/import/scan.ts`
4. **Scan endpoint** — `src/routes/api/admin/import/scan/+server.ts`
5. **Batch endpoint** — `src/routes/api/admin/import/batch/+server.ts`
6. **Tests (GREEN)** — Verify all pass
7. **UI** — Rework import modal in `src/routes/+page.svelte`
8. **Manual test + build check**
9. **Commit and push**

## File Summary

| Action | File |
|--------|------|
| Create | `src/lib/server/import/scan.ts` |
| Create | `src/routes/api/admin/import/scan/+server.ts` |
| Create | `src/routes/api/admin/import/batch/+server.ts` |
| Create | `tests/batch-import.test.ts` |
| Edit   | `src/lib/types.ts` (add batch import types) |
| Edit   | `src/routes/+page.svelte` (rework import modal for batch) |

## Complexity Assessment

This is a medium-sized feature. The heavy lifting (RTF conversion, tree walking, DB writes) is already done — `importScriv()` handles all of it. Batch import is essentially:
- A directory scanner (~60 lines)
- Two thin API endpoints (~40 lines each)
- UI state management for the multi-phase modal (~150 lines of Svelte changes)

Most of the work is in the UI. The backend is straightforward wrapping of existing functionality.

## Review Fixes Applied

Changes incorporated from Codex and Gemini code reviews of this plan:

| # | Source | Fix | What changed |
|---|--------|-----|--------------|
| 1 | Both | Async scan | `readdirSync` → `fs.promises.readdir` to avoid blocking event loop |
| 2 | Both | Safe root boundary | Vague denylist → `fs.realpathSync` + `os.homedir()` prefix check |
| 3 | Codex 2 | Symlink documentation | Documented that `dirent.isDirectory()` naturally skips symlinks; added test |
| 4 | Codex 4 | Remove contradictory fail-fast | Removed pre-validation pass; validate per-path inline, failures go in results |
| 5 | Codex 5 | Explicit isDirectory check | Added `statSync().isDirectory()` validation in scan + batch endpoints |
| 6 | Codex 6 | Word count totals | Added `total_word_count` to ImportReport, `total_words` to batch summary |
| 7 | Codex 7 | Modal state reset | State resets on open; stale scan responses ignored via AbortController |
| 8 | Codex 8 | Edge case tests | Added 4 tests: symlink skip, non-directory, nonexistent path, homedir boundary |

**Dismissed:**
- Gemini 3 (batch resume) — over-engineering for fast atomic imports
- Gemini 4 (200 on partial failure) — intentional batch API pattern, UI already handles it
- Gemini 5 (same-name projects) — already addressed by showing relative paths in checklist
