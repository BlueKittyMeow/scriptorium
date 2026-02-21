# Codex Code Review — The Difference Engine

## Review Target
- **Commit:** `2649a51` — "Add the Difference Engine: novel comparison and merge"
- **Scope:** 16 files changed, 1870 insertions — new feature (no modifications to existing logic beyond 1 line)

### Files to review

**Server modules (core logic):**
- `src/lib/server/compare/collect.ts` — Tree-walk document collector with injectable content reader
- `src/lib/server/compare/match.ts` — 4-phase document matching algorithm (exact title, fuzzy title, content similarity, unmatched)
- `src/lib/server/compare/diff.ts` — Word-level diff via jsdiff
- `src/lib/server/compare/merge.ts` — Merge execution: creates novel, documents, variant folders, FTS entries, audit log

**API endpoints:**
- `src/routes/api/compare/match/+server.ts` — POST: match chapters between two novels
- `src/routes/api/compare/diff/+server.ts` — POST: compute word-level diff for a document pair
- `src/routes/api/compare/merge/+server.ts` — POST: execute merge (recomputes matching server-side)

**UI components:**
- `src/routes/novels/compare/+page.svelte` — 3-step wizard (select → compare → merged)
- `src/routes/novels/compare/+page.server.ts` — Auth guard + novel list loader
- `src/lib/components/DiffView.svelte` — Word-level diff rendering
- `src/lib/components/MergeControls.svelte` — Per-pair merge choice radio buttons

**Supporting changes:**
- `src/lib/types.ts` — New types: CompareDocument, MatchedPair, DiffChange, PairDiff, MergeChoice, MergeInstruction, MergeReport
- `src/routes/+page.svelte` — Added "Compare Drafts" link to library actions
- `tests/compare.test.ts` — 35 tests across 4 layers

### Context files for reference
- `src/lib/server/compile/tree-walk.ts` — Existing tree-walk pattern this was modeled on
- `src/lib/server/files.ts` — `stripHtml()`, `countWords()`, `writeContentFile()`, `ensureNovelDirs()`
- `src/lib/server/audit.ts` — `logAction()` used by merge
- `src/lib/server/auth.ts` — `requireUser()` guard used by all endpoints

## Design decisions to be aware of

1. **Plaintext diffing** — HTML is stripped before diffing. Formatting differences are intentionally ignored; only prose changes matter.
2. **Jaccard similarity** — Inline implementation (~10 lines) for word-set overlap. 0.3 threshold for content matching.
3. **Iterative merge** — Compare two novels at a time. To merge 5 drafts: A+B → Merged AB, then Merged AB + C, etc.
4. **Variant folders** — "Keep both" creates a folder with two child documents, both `compile_include = 0`.
5. **Draft provenance** — Every merged document gets `synopsis = "From: {source novel title}"` so you can see the overall shape of each draft in the merged result.
6. **Server-side recomputation** — The merge endpoint recomputes matching rather than trusting client-provided pair data.
7. **Content reader injection** — `collectCompareDocuments` takes a `contentReader` callback for testability (tests use in-memory content, production uses `readContentFile`).

## Review focus areas

### 1. Matching algorithm correctness
- Does the 4-phase matching produce sensible results?
- Is greedy best-first for content similarity the right approach, or could it produce poor matches?
- Could the 0.3 Jaccard threshold be too low (matching unrelated chapters) or too high (missing similar ones)?
- Is the fuzzy title matching (containment + 0.7 length ratio) robust enough?

### 2. Merge integrity
- All merge operations are wrapped in `db.transaction()` — are there any paths that could leave partial state?
- File writes happen inside the transaction — if a file write fails after DB inserts, we'd have DB records without content files. Is this a concern?
- Are sort_order values correctly assigned for merged documents and variant folder children?

### 3. Security
- All three endpoints call `requireUser(locals)` — correct?
- The merge endpoint recomputes matching server-side. Could there be a mismatch between what the client saw and what the server recomputes (e.g., novel modified between match and merge)?
- Any input validation gaps? (novelId, docId are used in DB queries and file paths)

### 4. Performance
- `matchDocuments` has O(N²) phases for content similarity — acceptable for novel-sized inputs (typically 10-50 chapters)?
- `diffWords` on long chapters could be CPU-intensive — is there a risk of blocking the event loop?
- `collectCompareDocuments` reads all document content into memory — could this be a problem for very large novels?

### 5. UI patterns
- Svelte 5 runes usage: `$state`, `$derived`, `$props`, `$bindable` — correct patterns?
- The DiffView renders potentially large diffs inline — any concerns about DOM size?
- MergeControls uses `bind:group` with `$bindable` — is the two-way binding pattern correct?

### 6. Test coverage
- 35 tests across algorithms, DB operations, source scans — any gaps?
- The merge tests use `ensureNovelDirs` which creates real directories — are these cleaned up?
- No integration tests for the API endpoints themselves — acceptable for this phase?

### 7. Anything else
- Missing error handling or edge cases
- Patterns that could cause problems when comparing very different novels
- Suggestions for simplification or improvement

---

## Findings

| # | Severity | Finding | Details |
|---|----------|---------|---------|
| 1 | Medium | Unmatched A docs are appended out of order | `matchDocuments()` sorts matched pairs by Novel A order, then *appends* unmatched A docs afterward. This violates the stated “results sorted by Novel A’s order” and can reorder chapters (e.g., A1 matched, A2 unmatched, A3 matched becomes A1, A3, A2). Insert unmatched A docs in their original positions (merge the sequences) instead of appending. |
| 2 | Medium | Merge instructions are not validated for uniqueness/coverage | `/api/compare/merge` only checks `instructions.length === pairs.length`. A client can send duplicate `pairIndex` values or omit some indices, causing skipped or duplicated merges without error. Validate that `pairIndex` values are a complete, unique 0..N‑1 set and that `choice` is one of `a|b|both|skip`. |
| 3 | Medium | Diff endpoint bypasses DB ownership/soft‑delete checks | `/api/compare/diff` reads content directly from disk using `novelId`/`docId` without confirming the document belongs to the novel or is not deleted. An authenticated user can request deleted/foreign docs (or trigger 500s if invalid IDs hit path validation). Add DB lookups with `deleted_at IS NULL` and validate IDs before file access. |
| 4 | Medium | File writes inside DB transaction can leave orphaned files | `executeMerge()` writes content files inside the DB transaction. If a later insert fails and the transaction rolls back, written files remain on disk with no DB records. Conversely, a write failure after DB inserts causes partial DB state. Consider writing to temp files first, then committing DB, then renaming, or add cleanup on rollback. |
| 5 | Low | Empty content yields perfect similarity | `jaccardSimilarity()` returns `1.0` for two empty texts. If content files are missing (collector returns empty string), unrelated empty docs can be matched as “identical,” skewing phase‑3 content matching. Treat empty‑empty similarity as 0 (or skip similarity matching for empty docs). |

(Fill in findings above)
