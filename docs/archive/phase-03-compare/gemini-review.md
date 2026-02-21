# Gemini Code Review — The Difference Engine

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
- `src/lib/server/db.ts` — Database schema (novels, folders, documents, documents_fts, audit_log tables)

## Design decisions to be aware of

1. **Plaintext diffing** — HTML is stripped before diffing. Formatting differences are intentionally ignored; only prose changes matter.
2. **Jaccard similarity** — Inline implementation (~10 lines) for word-set overlap. 0.3 threshold for content matching.
3. **Iterative merge** — Compare two novels at a time. To merge 5 drafts: A+B → Merged AB, then Merged AB + C, etc.
4. **Variant folders** — "Keep both" creates a folder with two child documents, both `compile_include = 0`.
5. **Draft provenance** — Every merged document gets `synopsis = "From: {source novel title}"` so you can see the overall shape of each draft in the merged result.
6. **Server-side recomputation** — The merge endpoint recomputes matching rather than trusting client-provided pair data.
7. **Content reader injection** — `collectCompareDocuments` takes a `contentReader` callback for testability.

## Review focus areas

### 1. Algorithm correctness
- 4-phase matching: exact title → fuzzy title → content similarity → unmatched
- `normalizeTitle` strips "Chapter N" prefixes — could this be too aggressive or miss patterns?
- Jaccard similarity on word sets — does this work well for prose comparison, or would character-level or n-gram similarity be better?
- Greedy best-first content matching — could this produce suboptimal global matches?

### 2. Data integrity and transaction safety
- `executeMerge` wraps all DB operations in `db.transaction()` — are file writes inside the transaction safe? (SQLite transactions don't cover filesystem operations)
- FTS entries are created for all merged documents — is the `doc_id` → `documents_fts` relationship maintained correctly?
- `ensureNovelDirs()` creates directories inside the transaction — idempotent?
- Could a partial merge leave orphaned files on disk?

### 3. Security and input validation
- API endpoints use `requireUser(locals)` — no role restriction (writers can merge). Is this intentional?
- Novel IDs come from client JSON body — are they validated before use in DB queries and file paths?
- `validatePathSegment` is called by `ensureNovelDirs`/`writeContentFile` — but the document IDs in merge are UUIDs generated server-side. Any path traversal risk from the pair data?
- The diff endpoint takes `novelIdA`/`docIdA` from the client — used directly in `readContentFile`. Could a malicious client read arbitrary files?

### 4. Performance and scalability
- `matchDocuments` has O(N²) content similarity phase — what happens with 100+ chapter novels?
- `collectCompareDocuments` loads all document content into memory simultaneously — memory pressure for large novels?
- `diffWords` is synchronous and CPU-bound — could it block the Node.js event loop for very long chapters (50k+ words)?
- The merge endpoint recomputes matching — this means the full matching algorithm runs twice (once on match, once on merge). Necessary for security, but worth noting the cost.

### 5. Svelte 5 and UI patterns
- Component uses `$state`, `$derived`, `$props`, `$bindable` — correct Svelte 5 runes usage?
- `diffCache` is a plain object used with `$state` — does Svelte 5 reactivity track property additions on plain objects?
- The compare page manages all state locally (no stores) — appropriate for this use case?
- `MergeControls` uses `bind:group` with `$bindable` `choice` prop — is this the correct two-way binding pattern in Svelte 5?
- Accessibility: radio buttons, keyboard navigation, screen reader considerations?

### 6. Error handling and edge cases
- What happens if one novel is deleted between the match and merge steps?
- What if a document's content file is missing on disk?
- What if two novels have zero matchable chapters?
- The merge instruction count must equal the pair count — is this validated correctly?
- Are there any uncaught exceptions that could leave the user in a broken state?

### 7. Test coverage assessment
- 35 tests across 4 layers (algorithms, DB, source scans, UI scans)
- DB tests create real files via `writeContentFile`/`ensureNovelDirs` — are temp directories cleaned up?
- No API-level integration tests (endpoint tests are source scans only)
- Edge cases: empty novels, single-chapter novels, novels with identical content — covered?

---

## Findings

| # | Severity | Finding | Details |
|---|----------|---------|---------|
| 1 | 🟠 Medium | Non-Atomic Merge Filesystem Operations | `executeMerge` performs `writeContentFile` calls inside a DB transaction. Files written to `data/{novelId}/docs` will remain even if the transaction rolls back, leaving orphaned directories/files on failure. **Suggestion:** Write to a `.tmp` directory and rename to final `novelId` only after DB commit. |
| 2 | 🟡 Low | Missing DB Validation in Diff Endpoint | `/api/compare/diff` reads files based on client IDs without verifying existence in the DB. While path traversal is prevented via `validatePathSegment`, it allows probing the `data/` directory for valid IDs. **Suggestion:** Check DB for novel/document existence first. |
| 3 | 🟡 Low | Synchronous Diff Blocking | `diffWords` is CPU-bound and synchronous. Very large chapters (50k+ words) could block the Node.js event loop, affecting server responsiveness for other concurrent users. **Suggestion:** Use a worker thread for diffing if large documents are common. |
| 4 | 🟡 Low | Suboptimal Greedy Matching | Phase 3 matching uses a greedy best-first approach which may produce suboptimal global matches compared to a bipartite matching algorithm. **Suggestion:** Stable matching or bipartite matching would be more robust, though greedy is usually acceptable for prose. |
| 5 | 🔵 Note | Aggressive Title Normalization | `normalizeTitle` effectively strips "Chapter N" prefixes to handle numbering shifts, which is well-suited for the draft-merging use case. |
| 6 | 🔵 Note | Jaccard Similarity Logic | The use of Jaccard similarity on word sets intentionally ignores word order, making it resilient to sentence rearrangement between drafts. |

(Fill in findings above)
