# Scriptorium Code Review — Codex

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

- 🟠 **Binder tree exposes deleted nodes**  
  - **File:** `src/routes/api/novels/[id]/tree/+server.ts` (lines 10-35)  
  - **Snippet:**  
    ```ts
    const folders = locals.db.prepare(
      'SELECT * FROM folders WHERE novel_id = ? ORDER BY sort_order'
    ).all(params.id);
    const documents = locals.db.prepare(
      'SELECT * FROM documents WHERE novel_id = ? ORDER BY sort_order'
    ).all(params.id);
    ```  
  - **Why it matters:** The tree query never filters `deleted_at`, so soft-deleted folders/documents stay in the payload and the UI will continue to render trashed entries even though they are hidden elsewhere. This breaks the soft-delete guarantees and can surface trash items that should only be accessible via the deleted/restore flows.

- 🟠 **Node creation/reparenting allows inter-novel or orphan parents**  
  - **Files:** `src/routes/api/novels/[id]/tree/nodes/+server.ts` (lines 15-34), `src/routes/api/novels/[id]/tree/+server.ts` (lines 56-66)  
  - **Snippets:**  
    ```ts
    INSERT INTO folders (...) VALUES (..., body.parent_id || null, ...);
    INSERT INTO documents (...) VALUES (..., body.parent_id || null, ...);
    ```  
    ```ts
    UPDATE ${table} SET parent_id = ?, ... WHERE id = ? AND novel_id = ?
    ```  
  - **Why it matters:** Neither API verifies that `parent_id`/`new_parent_id` points to a folder that belongs to the same novel (or even exists). Clients can therefore assign nodes to folders from other novels or to non-existent parents, creating orphaned entries that never show up in the binder tree yet remain editable. It also breaks the assumption that a novel’s tree is self-contained.

- 🟠 **Import runner allows path traversal via binder IDs**  
  - **File:** `src/lib/server/import/scriv.ts` (lines 227-245)  
  - **Snippet:**  
    ```ts
    const rtfPaths = [
      path.join(docsDir, `${scrivId}.rtf`),
      path.join(docsDir, scrivId, 'content.rtf')
    ];
    ```  
  - **Why it matters:** `scrivId` comes directly from the attacker-controlled `.scrivx` file and is interpolated into `path.join` without normalization or whitelist checks. A crafted binder ID like `../../../../etc/passwd` lets the importer read arbitrary `.rtf` files outside `docsDir` (and therefore outside the project root) whenever such files exist. Because this endpoint is exposed via `/api/admin/import`, an unauthenticated caller can trigger it with a malicious `.scrivx` to exfiltrate server files. Normalizing and enforcing that the resolved path stays within `docsDir` (or rejecting IDs with path separators) is needed.

1. 🟠 Major — `src/routes/+page.svelte:104`
   The novel cards wrap the entire  link, but the `href` is written as a literal string (`"/novels/{novel.id}"`). Svelte does not interpolate expressions inside quoted attributes, so every card points to `/novels/{novel.id}` and users cannot move from the library to a novel at all.
   ```svelte
   <a class="novel-card" href="/novels/{novel.id}">
   ```

2. 🟠 Major — `src/routes/novels/[id]/+page.svelte:389-403`
   Search results render `result.snippet` with `{@html result.snippet}` even though the snippet is generated from stored document HTML. An attacker who can edit a document can persist arbitrary HTML/JS (e.g., `<script>…</script>` or `onerror` attributes); when anyone triggers that search, the unsanitized snippet is injected into the DOM and executed, resulting in stored XSS across the workspace.
   ```svelte
   <span class="result-snippet">{@html result.snippet}</span>
   ```

3. 🟡 Minor — `src/lib/components/Editor.svelte:114-129`
   Both the `onDestroy` handler and the doc-switch effect call `onsave?.(editor.getHTML())` without `await`/`try` or any error handling. The promise rejection is discarded as an unhandled rejection, and the component immediately destroys the editor, so the autosave may not complete before navigation/switch, meaning edits can be silently dropped if the network fails.
 ```ts
 onDestroy(() => {
     clearTimeout(saveTimeout);
     if (editor && saveStatus === 'unsaved') {
         onsave?.(editor.getHTML());
     }
     editor?.destroy();
 });

 $effect(() => {
     const newDocId = docId;
     if (newDocId !== currentDocId && editor) {
         if (currentDocId && saveStatus === 'unsaved') {
             clearTimeout(saveTimeout);
             onsave?.(editor.getHTML());
         }
         ...
     }
 });
 ```

- **🟠 Major | `src/lib/server/db.ts`:17-27**
  - **Snippet**
    ```ts
    fs.mkdirSync(DATA_ROOT, { recursive: true });

    const dbPath = path.join(DATA_ROOT, 'scriptorium.db');
    _db = new Database(dbPath);

    // Enable WAL mode for concurrent reads during writes
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    ```
  - **Issue:** The singleton connection never sets `PRAGMA busy_timeout`. `better-sqlite3` defaults to 0ms, so any concurrent writers (autosave, manual saves, imports, snapshots) will immediately raise `SQLITE_BUSY` and crash the request while updates to the DB/FTS still roll back. WAL mode increases the probability of simultaneous writers. Configure a busy timeout (e.g., `_db.pragma('busy_timeout = 5000')`) when the DB opens so writers block briefly instead of throwing.

- **🟡 Minor | `src/lib/server/files.ts`:36-47**
  - **Snippet**
    ```ts
    export function writeFileAtomic(filePath: string, content: string): void {
      const tmpPath = filePath + '.tmp';
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, filePath);
    }
    ```
  - **Issue:** Atomicity is claimed, but the parent directory is never synced after `renameSync`. On Unix filesystems a crash/power loss between the rename and the directory metadata flush can discard the newly written file, even though the database thinks the HTML has been updated or a snapshot was created. To guarantee the rename survives crashes, open the directory containing `filePath` and call `fs.fsyncSync` on it before returning (or use `fsync` on a dir file descriptor returned by `fs.openSync(path.dirname(filePath), 'r')`).

1. 🟠 Major — `src/routes/+page.svelte:104`
   The novel cards wrap the entire  link, but the `href` is written as a literal string (`"/novels/{novel.id}"`). Svelte does not interpolate expressions inside quoted attributes, so every card points to `/novels/{novel.id}` and users cannot move from the library to a novel at all.
   ```svelte
   <a class="novel-card" href="/novels/{novel.id}">
   ```

2. 🟠 Major — `src/routes/novels/[id]/+page.svelte:389-403`
   Search results render `result.snippet` with `{@html result.snippet}` even though the snippet is generated from stored document HTML. An attacker who can edit a document can persist arbitrary HTML/JS (e.g., `<script>…</script>` or `onerror` attributes); when anyone triggers that search, the unsanitized snippet is injected into the DOM and executed, resulting in stored XSS across the workspace.
   ```svelte
   <span class="result-snippet">{@html result.snippet}</span>
   ```

3. 🟡 Minor — `src/lib/components/Editor.svelte:114-129`
   Both the `onDestroy` handler and the doc-switch effect call `onsave?.(editor.getHTML())` without `await`/`try` or any error handling. The promise rejection is discarded as an unhandled rejection, and the component immediately destroys the editor, so the autosave may not complete before navigation/switch, meaning edits can be silently dropped if the network fails.
   ```ts
   onDestroy(() => {
       clearTimeout(saveTimeout);
       if (editor && saveStatus === 'unsaved') {
           onsave?.(editor.getHTML());
       }
       editor?.destroy();
   });

   $effect(() => {
       const newDocId = docId;
       if (newDocId !== currentDocId && editor) {
           if (currentDocId && saveStatus === 'unsaved') {
               clearTimeout(saveTimeout);
               onsave?.(editor.getHTML());
           }
           ...
       }
   });
   ```
