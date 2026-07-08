# Scriptorium Remediation & Improvement Plan

**Date:** 2026-07-08
**Source:** Full codebase review (all server routes, lib modules, and primary components; `npm test` 232/232 passing; `npm run check` failing with 108 type errors, all in tests)
**Audience:** Any engineer or model executing fixes. Each item states the file, the defect, why it matters, the fix, and how to verify. Work top-down: P0 before P1 before P2.

Bugs marked **[verified]** were reproduced against better-sqlite3 with the production schema during this review. Bugs marked **[traced]** were confirmed by code-path analysis but not executed.

---

## P0 — Critical (data corruption / broken features)

### P0-1. Doc-switch flush writes the OLD document's content into the NEW document [traced]

**Files:** [src/lib/components/Editor.svelte](../src/lib/components/Editor.svelte) (`switchDocument`, ~line 184), [src/routes/novels/[id]/+page.svelte](../src/routes/novels/[id]/+page.svelte) (`saveDocument`, ~line 92)

**Defect:** The save callback resolves its target from parent state *at save time*, not from the document the content came from:

1. User has unsaved edits in doc X. Clicks doc Y in the binder.
2. `selectDocument(Y)` sets `activeDocId = Y` synchronously, then fetches Y.
3. When `activeDoc` updates, Editor's `$effect` sees `docId` changed and calls `switchDocument`, which flushes: `await onsave(editor.getHTML())` — editor still holds **X's content**.
4. Parent's `saveDocument` does `PUT /api/documents/${activeDocId}` — but `activeDocId` is already **Y**.

Result: X's unsaved edits overwrite Y's content on disk, in `word_count`, and in FTS. X's edits are also lost from X (never saved there). A snapshot of the corrupted Y content may be created. This is the worst possible failure mode for a preservation-first app. The same mis-targeting applies to the 2-second debounce timer if it fires mid-switch (the `clearTimeout` in `switchDocument` only runs in the `unsaved` branch, and the parent callback always reads current `activeDocId`).

**Fix:** Make the save carry its own target id end to end.

1. Change the prop signature: `onsave: (content: string, docId: string) => Promise<void>`.
2. In Editor, every call site passes the id the content belongs to: `triggerSave` and `switchDocument` pass `currentDocId` (capture `const target = currentDocId` before any `await`).
3. In the parent, `saveDocument(content, docId)` PUTs to `/api/documents/${docId}` and updates the tree word count for `docId`, not `activeDocId`.
4. In `switchDocument`, flush the old doc **before** `editor.commands.setContent(initialContent)` (already the case) and keep the `clearTimeout` unconditional at the top of the function.

**Verify:** Add a Vitest source-grep test asserting `onsave(` in Editor.svelte is always called with two arguments and that `saveDocument` uses its parameter, not `activeDocId`, in the fetch URL. Manual: type in doc X, immediately click doc Y within 2s; confirm Y's content unchanged on disk (`data/{novel}/docs/{Y}.html`) and X's edits saved to X.

### P0-2. Purging a novel from admin trash always throws 500 [verified]

**File:** [src/routes/api/admin/trash/[type]/[id]/purge/+server.ts](../src/routes/api/admin/trash/[type]/[id]/purge/+server.ts) line 22

```ts
const docs = locals.db.prepare('SELECT id FROM documents WHERE novel_id = ?').all() as ...
```

`.all()` is called with no bind value while the SQL has a `?` placeholder. better-sqlite3 throws `RangeError: Too few parameter values were provided` on every novel purge — the feature has never worked. (Reproduced directly.) Note the fix must pass the **novel id**: `.all(id)`. Had the query silently run unfiltered it would have wiped FTS and snapshots for every document in the database, so also add a regression test, not just the one-character fix.

**Fix:** `.all(id)`. While here, also delete `audit_log` is *not* required (no FK on entity_id), but see P0-3 for the users FK.

**Verify:** Extend `tests/` (in-memory DB, same pattern as `tests/db.test.ts`): create novel + 2 docs + snapshots + FTS rows, soft-delete novel, run the purge handler's transaction body, assert novel/docs/snapshots/FTS rows gone and other novels' rows intact.

### P0-3. Deleting any user who has audit-log entries fails with FK constraint [verified]

**File:** [src/routes/api/admin/users/[userId]/+server.ts](../src/routes/api/admin/users/[userId]/+server.ts) (DELETE, ~line 114); schema in [src/lib/server/db.ts](../src/lib/server/db.ts) line 125

`audit_log.user_id REFERENCES users(id)` with no `ON DELETE` action and `foreign_keys = ON`. Every login writes an audit row, so **any user who has ever logged in cannot be deleted** — the DELETE throws `FOREIGN KEY constraint failed` (reproduced) and surfaces as a 500.

**Fix (recommended, no schema migration):** inside the existing delete transaction, before deleting the user:

```ts
locals.db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(userId);
```

The audit GET already `LEFT JOIN`s users, so NULL user_id renders fine. To preserve attribution, first write an audit entry from the acting archivist: `logAction(db, locals.user!.id, 'user.delete', 'user', userId, `Deleted "${user.username}"`)` — and consider adding the deleted username into the details of the NULLed rows' replacement (optional). A schema-level alternative (`ON DELETE SET NULL`) requires a SQLite table rebuild since the table already exists in production DBs; not worth it now, but note it for a future migrations system (P2-6).

**Verify:** Test: create archivist + writer, `logAction(..., writerId, 'user.login')`, run DELETE handler logic, assert user gone, audit rows remain with `user_id IS NULL`.

---

## P1 — Data integrity and correctness

### P1-1. Restoring a novel from admin trash restores an empty shell

**File:** [src/routes/api/admin/trash/[type]/[id]/restore/+server.ts](../src/routes/api/admin/trash/[type]/[id]/restore/+server.ts) (novel branch)

`softDeleteNovel` cascades `deleted_at` onto all folders and documents, but restore only clears the novel row. The restored novel opens with an empty binder; every folder/doc must be restored one-by-one from the trash list.

**Fix:** Timestamp-matched cascade restore, in a transaction. Read the novel's `deleted_at` first, then:

```sql
UPDATE folders   SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = :novelDeletedAt;
UPDATE documents SET deleted_at = NULL, updated_at = ? WHERE novel_id = ? AND deleted_at = :novelDeletedAt;
```

Matching on the exact timestamp preserves items that were individually trashed *before* the novel was deleted (they keep their own earlier `deleted_at`). Then re-index FTS for each restored document using `reindexDocFts` from [tree-ops.ts](../src/lib/server/tree-ops.ts).

**Verify:** Test: build novel with folder + 2 docs, individually trash doc A (t1), soft-delete novel (t2), restore novel; assert folder + doc B restored and indexed, doc A still trashed.

### P1-2. Admin trash restore of a document indexes raw HTML from a hardcoded relative path

**File:** same file, document branch (~line 27)

```ts
const contentPath = `data/${row.novel_id}/docs/${id}.html`;
```

Two defects: (a) ignores `DATA_ROOT` and resolves against process CWD — with a custom `DATA_ROOT` or different working directory the read silently fails and the doc is indexed with empty content; (b) on success it inserts **raw HTML** into FTS (every other path indexes `stripHtml(...)` output), so tag names become searchable and snippets are polluted; (c) it INSERTs without a preceding DELETE, so repeated restore cycles can leave duplicate FTS rows for one doc_id → duplicate search results.

**Fix:** Replace the whole block with the existing helper:

```ts
import { reindexDocFts } from '$lib/server/tree-ops.js';
import { readContentFile, stripHtml } from '$lib/server/files.js';
reindexDocFts(locals.db, { id, title: row.title, novel_id: row.novel_id }, readContentFile, stripHtml);
```

`reindexDocFts` deletes-then-inserts and strips HTML. Grep the codebase for any other direct `INSERT INTO documents_fts` and consolidate on the helper where a doc may already have a row (creation paths are fine).

**Verify:** Test: doc with `<p>hello world</p>` content and non-default DATA_ROOT; soft-delete, restore via handler; FTS content equals `hello world`, exactly one FTS row.

### P1-3. Restored items whose ancestor folder is still deleted vanish from the UI

**Files:** [src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts](../src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts) (PATCH restore), admin restore route (folder/document branches)

Restore clears `deleted_at` on the node only. If its parent folder remains trashed, the node is neither rendered in the binder (parent subtree is skipped) nor listed in trash (its own `deleted_at` is NULL). It becomes unreachable except through search.

**Fix:** After clearing `deleted_at`, walk up `parent_id`; if any ancestor has `deleted_at IS NOT NULL` (or the parent row no longer exists — see P1-4), set the restored node's `parent_id = NULL` so it reappears at the binder root. Apply the same logic in both restore endpoints. Alternative (auto-restore ancestors) resurrects siblings the user didn't ask for; re-rooting is the least-surprise behavior.

**Verify:** Test: folder F containing doc D; trash F (cascades to D); restore D only; assert D has `parent_id IS NULL`, `deleted_at IS NULL`, and appears in a rebuilt tree.

### P1-4. Purging a folder orphans its children and leaks their files

**File:** purge route, folder branch (~line 38)

Folder purge deletes only the folder row. Soft-deleted children keep dangling `parent_id`s; their content files, snapshot files, snapshot rows, and (for docs trashed via cascade) any FTS state are never cleaned. Restoring such a child later makes it invisible (P1-3 mitigates but the disk/DB leak remains).

**Fix:** Recursive purge in a transaction mirroring `cascadeDeleteChildren`: for each descendant document — delete FTS row, snapshot rows, content file, snapshot dir; for each descendant folder — recurse then delete row; finally delete the target folder row. Factor a `purgeDocument(db, dataRoot, doc)` helper shared with the existing document branch so file cleanup lives in one place.

**Verify:** Test: folder → subfolder → doc with snapshot; trash folder, purge folder; assert zero remaining rows for all three and both files gone.

### P1-5. Tree reorder endpoint trusts the client completely

**File:** [src/routes/api/novels/[id]/tree/+server.ts](../src/routes/api/novels/[id]/tree/+server.ts) (PUT, ~line 59)

No validation that: the node exists and belongs to the novel; `new_parent_id` (when set) is an existing, non-deleted **folder** in the same novel; the move doesn't create a cycle (folder moved into its own descendant). The client guards against cycles, but the API doesn't — a buggy client or manual request makes the subtree unreachable (buildTree never visits it), which reads as silent data loss. `new_sort_order` is also unchecked (`undefined` would write NULL into a NOT NULL column and 500).

**Fix:** In order: (1) 400 unless `node_type` is `'folder' | 'document'` and `typeof new_sort_order === 'number'` and finite; (2) 404 if the node isn't in this novel or is deleted; (3) if `new_parent_id` set, 400 unless it's a non-deleted folder in this novel; (4) for folders, walk up from `new_parent_id` via `parent_id` — 400 if the chain contains `node_id`. Wrap in nothing special; it's a single UPDATE.

**Verify:** Tests for each rejection + a happy-path move. Cycle test: A→B nested, attempt to move A inside B, expect 400.

### P1-6. Single-project import endpoint skips the home-directory boundary

**File:** [src/routes/api/import/+server.ts](../src/routes/api/import/+server.ts)

`/api/import/scan` and `/api/import/batch` both resolve symlinks and enforce "must be under `os.homedir()`". `POST /api/import` accepts **any** path on the filesystem with no tilde expansion, no `realpathSync`, no boundary. Any authenticated user can point it at arbitrary readable directories. Low practical risk for a two-user family install, but it's an inconsistency that will bite when Phase 3 exposes the app to the internet.

**Fix:** Extract the expand → realpath → boundary-check → isDirectory sequence from `batch/+server.ts` into a shared helper (e.g. `src/lib/server/import/resolve-path.ts`, returning `{ resolved } | { error }`), use it in all three import endpoints.

**Verify:** Existing security tests cover scan/batch; add the same cases against `/api/import` (path outside home → 400; `~/...` expansion works).

### P1-7. Scrivener import writes FTS rows and content files for folders

**File:** [src/lib/server/import/scriv.ts](../src/lib/server/import/scriv.ts) — `tryImportContent` is called for folders (line 198) and unconditionally inserts into `documents_fts` (line 299) and writes a content file keyed by the **folder** id.

Effects: junk FTS rows with doc_ids that aren't documents (invisible in search results thanks to the JOIN, but never cleaned by any delete/purge path, and they inflate the index), plus orphan `docs/{folderId}.html` files. Scrivener folders can legitimately carry text, so the content isn't garbage — it's just stored where nothing can read it.

**Fix:** In the folder branch, if RTF content exists, create a **child document** (title like `"{folder title} (notes)"`, sort_order 0.5 so it sorts first) and import into that. Otherwise skip. Remove the unconditional FTS insert from the folder path.

**Verify:** Test with a fixture .scriv where a folder has `content.rtf`: assert a real document row exists containing the text, no FTS row keyed by a folder id (`SELECT doc_id FROM documents_fts LEFT JOIN documents ... WHERE documents.id IS NULL` returns empty).

### P1-8. Import is not transactional and rollback leaves files behind

**File:** [scriv.ts](../src/lib/server/import/scriv.ts) lines 131–145

DB inserts happen incrementally across `await` points (RTF conversion), so a process crash mid-import leaves a partial novel. The manual catch-rollback handles thrown errors but doesn't remove content files already written to `data/{novelId}/docs/`.

**Fix (pragmatic, keeps async structure):** two-phase import. Phase 1: walk the binder, convert all RTF to HTML in memory (no DB writes, no file writes), building a flat list of `{folder|doc, parentRef, title, html, ...}`. Phase 2: one `db.transaction()` that inserts all rows, then write files after commit (file-after-DB is safe here: a missing content file reads as empty, matching `readContentFile`'s null fallback, and re-import is cheap). In the existing catch block, also `fs.rmSync(path.join(getDataRoot(), novelId), { recursive: true, force: true })`.

**Verify:** Existing import tests keep passing; add one that injects a throwing reader mid-walk and asserts zero rows *and* no `data/{novelId}` directory remain.

---

## P2 — Hygiene, robustness, DX

### P2-1. Fix the failing typecheck: missing type packages, then 9 real errors
`npm run check` reports 108 errors — every one is `Cannot find module 'fs'/'path'/'os'` or missing better-sqlite3 types in `tests/`. Fix: `npm i -D @types/node @types/better-sqlite3`. This makes `check` a usable gate again; consider adding `npm run check && npm test` as a pre-commit habit.

**Verified 2026-07-08:** after installing those two packages, the noise drops away and **9 genuine type errors + 2 warnings** surface. None are behavior bugs, but they must be fixed for `check` to go green:

1. `vite.config.ts:6` — `test` is not a known key: import `defineConfig` from **`vitest/config`** instead of `vite`.
2. `src/lib/server/import/scriv.ts:3` — `@iarna/rtf-to-html` has no types: add `src/ambient.d.ts` containing `declare module '@iarna/rtf-to-html';`.
3. `src/routes/api/novels/[id]/compile/+server.ts:61` — `Buffer` isn't assignable to `BodyInit` under DOM types: wrap as `new Response(new Uint8Array(result.buffer), ...)` (compile outputs are small; the copy is fine).
4. `src/routes/api/novels/[id]/tree/nodes/+server.ts:24` and `:38` — spreading an `unknown` row now that better-sqlite3 is typed: cast the `.get(id)` result `as Record<string, unknown>`.
5. `src/routes/+page.svelte:31` (×3) — `let importMode: ImportMode = $state('idle')` narrows to the literal `'idle'`; use the generic form `$state<ImportMode>('idle')`.
6. `src/routes/novels/[id]/+page.svelte:657` — `$page.params.id` is `string | undefined` but `CompileDialog.novelId` wants `string`: `const novelId = $derived($page.params.id!)` (the route guarantees the param).

Warnings worth clearing while there: `novels/[id]/+page.svelte:26` — `searchInputEl` is reassigned via `bind:this` but not `$state`; declare `let searchInputEl = $state<HTMLInputElement | undefined>()`. `CompileDialog.svelte:172` — the bare `<label>Include in compilation</label>` has no associated control; change to a `<span>`/`<p>` with the same styling (or a `fieldset`/`legend`).

### P2-2. Client `saveDocument` ignores HTTP failures
[+page.svelte](../src/routes/novels/[id]/+page.svelte) `saveDocument` never checks `res.ok`, so a failed save still resolves and the Editor shows **Saved**. Fix: `if (!res.ok) throw new Error(...)` — Editor's `triggerSave` catch already flips status to `unsaved`. Do this together with P0-1 since the function is being edited anyway.

### P2-3. `getNextSortOrder` returns the wrong sibling list for nested parents
[+page.svelte](../src/routes/novels/[id]/+page.svelte) ~line 248: `findChildren` returns `n.children` whenever a *deeper* recursive search succeeded (`if (found.length || n.id === pid) return n.children;`). Creating an item inside a nested folder computes max sort_order from the wrong level → duplicate/misordered sort_orders. Fix: return a `TreeNode[] | null` sentinel and propagate the recursive result:

```ts
function findChildren(nodes: TreeNode[], pid: string): TreeNode[] | null {
    for (const n of nodes) {
        if (n.id === pid) return n.children;
        const found = findChildren(n.children, pid);
        if (found) return found;
    }
    return null;
}
```

Also delete the dead `collectFolderIds` closure inside `loadTree` (lines 61–69, never called).

### P2-4. Document PUT: validate title/synopsis
[documents/[id]/+server.ts](../src/routes/api/documents/[id]/+server.ts): `COALESCE(?, title)` treats `""` as a value, so `{title: ""}` blanks a title; there are no length caps on title/synopsis/content. Fix: `const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;` (same for synopsis); optionally reject bodies > some sane size (e.g. 10 MB) with 413.

### P2-5. Create-node endpoint: validate parent
[tree/nodes/+server.ts](../src/routes/api/novels/[id]/tree/nodes/+server.ts): `body.parent_id` is written unchecked — a bogus or trashed parent id creates an invisible node (same class as P1-3). Fix: if `parent_id` given, 400 unless it's a non-deleted folder in this novel (share the validator with P1-5).

### P2-6. Schema migrations scaffold
`db.ts` runs `CREATE TABLE IF NOT EXISTS` only — existing databases never receive schema changes (this is why P0-3's clean fix is blocked). Add a minimal migrations table (`PRAGMA user_version` is enough): on startup, run numbered migration functions above the current version inside a transaction, then bump. Keep the base SCHEMA for fresh DBs as migration 0. This unlocks: `audit_log ON DELETE SET NULL`, future indexes, and Phase 3/4 tables.

### P2-7. Snapshot `content_path` is stored as written, including a relative DATA_ROOT
[files.ts](../src/lib/server/files.ts) + snapshot handlers store `path.join(DATA_ROOT, ...)` — with the default `./data` that's a **CWD-relative** path in the DB. Launching the server from a different working directory (or moving DATA_ROOT) breaks every existing snapshot read. Fix: store paths relative to DATA_ROOT (`{novelId}/snapshots/{docId}/{snapId}.html`) and resolve against `getDataRoot()` at read time; migration (via P2-6): strip any leading `{oldRoot}/` prefix from existing rows, or resolve reads with a fallback (try as-is, then relative-to-root).

### P2-8. Pandoc spawn: guard stdin errors
[pandoc.ts](../src/lib/server/compile/pandoc.ts): if pandoc dies early (bad args, OOM), `proc.stdin.write` can emit an unhandled `EPIPE` that crashes the process. Add `proc.stdin.on('error', () => {})` (the `close` handler already reports the real failure) and note `code === null` (timeout kill) already rejects via the else branch.

### P2-9. Login hardening (small)
[login/+server.ts](../src/routes/api/auth/login/+server.ts): (a) the rate-limit `Map` grows forever — sweep expired entries when it exceeds ~1000 keys; (b) unknown-username returns ~instantly while wrong-password takes a bcrypt compare (~100–400 ms) — a timing oracle for username enumeration. Fix: on user-not-found, `await verifyPassword(password, DUMMY_HASH)` (a constant bcrypt hash) before throwing the same 401.

### P2-10. Session validation does a redundant query
[hooks.server.ts](../src/hooks.server.ts) re-SELECTs `expires_at` that `validateSession` already fetched. Return `expiresAt` from `validateSession` and drop the second query — one fewer DB hit on literally every request.

### P2-11. `.all()`/`.get()` `as any` sprawl
Route handlers cast rows to `any` throughout. Define row interfaces once in `src/lib/types.ts` (NovelRow, DocumentRow, FolderRow, SnapshotRow, UserRow) and use `.get(...) as DocumentRow | undefined`. Not urgent; do it opportunistically when touching each file. (P0-2 is exactly the class of bug typed rows don't catch but tests do — prefer tests for behavior, types for shape.)

---

## P3 — Enhancements (planned work, not defects)

### P3-1. Snapshot retention / thinning
Autosave snapshots accrue every 2 minutes of active writing, forever (the storage dashboard exists partly because of this). Implement a thinning policy that preserves the preservation-first ethos: keep everything < 24 h old; keep hourly for 7 days; keep daily thereafter; never delete `manual` or `pre-restore` snapshots. Run opportunistically (e.g., after snapshot creation, thin that document's history in the same transaction; files deleted after commit). Make it an archivist setting with an off switch, and surface "N snapshots thinned" in the audit log.

### P3-2. Skip identical-content autosave snapshots
Before writing an autosave snapshot, compare a SHA-256 of the HTML against the most recent snapshot's hash (add a `content_hash` column via migrations). Idle-but-open editors currently create a snapshot every save cycle past the 2-minute mark even with zero changes.

### P3-3. Admin "Reindex search" action
FTS consistency depends on many call sites doing delete+insert correctly (P1-2 shows drift already occurred). Add `POST /api/admin/reindex`: rebuild `documents_fts` from scratch in one transaction (`DELETE FROM documents_fts`, then insert every non-deleted document via `reindexDocFts`). Cheap insurance and a support tool when search looks wrong.

### P3-4. Interim backups before Phase 3
The spec's per-user Google Drive backup lands in Phase 3, but the DB and content files deserve protection now. Minimal viable version: a `scripts/backup.sh` that (1) `sqlite3 scriptorium.db "VACUUM INTO 'backup/scriptorium-$(date).db'"` (safe under WAL, no downtime), (2) rsyncs `data/` to a target dir; document a cron line in the README. Keep it out of the app entirely.

### P3-5. sort_order renumbering
Midpoint insertion (`(a+b)/2` in drag-and-drop) halves the gap each time; ~50 consecutive drops in the same slot exhausts float precision and two items get equal sort_order (tie order then unstable). Low urgency. Fix opportunistically: when a computed midpoint gets within `1e-9` of a neighbor, renumber that sibling group to integers (1, 2, 3…) in the same transaction as the move.

### P3-6. Origin check as CSRF defense-in-depth
`SameSite=Lax` cookies already block cross-site POSTs in modern browsers, and SvelteKit blocks cross-origin form posts. For belt-and-braces before internet exposure (Phase 3), add a check in `hooks.server.ts`: for non-GET API requests with an `Origin` header, reject when it doesn't match `url.origin`. Also set `ORIGIN` env for adapter-node in deployment docs, and revisit the `secure`-cookie heuristic (Host-header sniffing) once behind a tunnel — prefer an explicit `FORCE_SECURE_COOKIES=1`.

### P3-7. Merge determinism guard (compare/merge)
`/api/compare/merge` recomputes pairs server-side and validates only `instructions.length === pairs.length`. If a document is edited/trashed between match and merge, indices silently shift and choices apply to the wrong chapters. Cheap fix: client echoes back, per instruction, the `docA?.id`/`docB?.id` it believes it's choosing between; server 409s on mismatch ("Novels changed since comparison — re-run the match").

---

## Explicit non-issues (checked, fine as-is)

- **Path traversal:** `validatePathSegment` + UUID-only ids on all file paths; scan/batch imports realpath + homedir-bound. (Single import is the gap — P1-6.)
- **FTS injection:** search tokens are quoted and `"`-escaped; snippet output sanitized to `<mark>` only before `{@html}`.
- **Shell injection in compile:** pandoc invoked via `spawn` argv, never a shell.
- **XSS in compile/preview:** titles escaped; preview served with a restrictive CSP.
- **Sessions:** tokens random 32-byte, stored SHA-256-hashed, sliding expiry with a 7-day threshold to avoid autosave write amplification — all sound.
- **Snapshot restore flow:** pre-restore snapshot + transaction ordering is careful and correct.
- **Compare/merge validation:** server-side recomputation, pairIndex uniqueness/range checks — good (see P3-7 for the one residual gap).
- **Editor unload save:** `keepalive: true` PUT on destroy targets `currentDocId` (correct id, unlike the switch path).

## Suggested execution order

1. **PR 1 (P0):** P0-1 + P2-2 (same files), P0-2, P0-3 — with regression tests for each.
2. **PR 2 (trash/restore integrity):** P1-1 … P1-4 as one unit; they share helpers and tests.
3. **PR 3 (validation):** P1-5, P1-6, P2-4, P2-5 (shared validators).
4. **PR 4 (import):** P1-7, P1-8.
5. **PR 5 (hygiene):** P2-1, P2-3, P2-8, P2-9, P2-10, P2-7 (+P2-6 scaffold first).
6. **P3 items** as individual follow-ups, P3-3 and P3-4 first.
