# Scriptorium Phase 1a — Snapshot Browser
### "Show me Tuesday's version"

**Scope:** Timeline view of document snapshots, read snapshot content, restore to a previous version (non-destructive). No new dependencies.

**Spec reference:** `spec.md` v0.4, Phase 1 → "Snapshot browser with timeline"

---

## What Already Exists

The snapshot infrastructure is fully built from MVP:

| Component | Status | Location |
|-----------|--------|----------|
| Snapshot DB table | Done | `src/lib/server/db.ts` — `snapshots(id, document_id, content_path, word_count, reason, created_at)` |
| Auto-snapshot on save (2-min debounce) | Done | `src/routes/api/documents/[id]/+server.ts` — PUT handler |
| Manual snapshot endpoint | Done | `POST /api/documents/:id/snapshots` |
| List snapshots endpoint | Done | `GET /api/documents/:id/snapshots` (returns `id, document_id, word_count, reason, created_at` ordered by `created_at DESC`) |
| Read snapshot content | Done | `GET /api/documents/:id/snapshots/:snapId` (reads file from `content_path`) |
| Snapshot file storage | Done | `data/{novelId}/snapshots/{docId}/{timestamp}.html` |
| TypeScript types | Done | `src/lib/types.ts` — `Snapshot` interface |

**What's missing:** A restore endpoint, the entire UI layer, and several fixes to existing snapshot endpoints discovered during code review.

---

## Layer 0: Existing Bug Fixes

Before building new features, fix issues discovered in the existing snapshot infrastructure during code review (Codex + Gemini, verified).

### 0a. Snapshot content endpoint: enforce deleted_at check

**File:** `src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts`

The individual snapshot content read does not verify the parent document is non-deleted. The list endpoint checks `deleted_at IS NULL` but direct access by snapshot ID bypasses this.

**Fix:** Join against `documents` and reject if `deleted_at IS NOT NULL`.

### 0b. Manual snapshot endpoint: wrap in transaction

**File:** `src/routes/api/documents/[id]/snapshots/+server.ts`

The POST handler runs `INSERT INTO snapshots` and `UPDATE documents SET last_snapshot_at` as two separate calls. If the second fails, `last_snapshot_at` is stale.

**Fix:** Wrap both DB operations in `locals.db.transaction()`.

### 0c. Snapshot list: add secondary sort key

**File:** `src/routes/api/documents/[id]/snapshots/+server.ts`

`ORDER BY created_at DESC` is non-deterministic when timestamps collide (same-millisecond snapshots from autosave + manual, or pre-restore + autosave).

**Fix:** Change to `ORDER BY created_at DESC, id DESC`.

### 0d. Snapshot filenames: use UUID instead of timestamp

**Files:** `src/lib/server/files.ts`, callers in `+server.ts`

Current snapshot filenames use `now.replace(/[:.]/g, '-')` — millisecond precision. Two snapshots in the same millisecond collide and overwrite. This can happen with pre-restore + autosave in quick succession.

**Fix:** Use the snapshot UUID as the filename: `{snapId}.html` instead of `{timestamp}.html`. The `snapshotPath` function becomes `snapshotPath(novelId, docId, snapId)`. Timestamps are stored in the DB `created_at` column where they belong.

### 0e. TypeScript type: add SnapshotSummary

**File:** `src/lib/types.ts`

The `Snapshot` interface includes `content_path` but the list endpoint doesn't return it. Add a `SnapshotSummary` type matching the list endpoint shape:

```ts
export interface SnapshotSummary {
  id: string;
  document_id: string;
  word_count: number | null;
  reason: string;
  created_at: string;
}
```

---

## Layer 1: Restore Endpoint

**Goal:** `POST /api/documents/:id/restore/:snapshotId` — non-destructive restore.

### Behavior

Per spec: "Restore this version" creates a NEW snapshot of current state, THEN reverts. So restoration is itself non-destructive.

### Operation sequence

Ordering matters. File writes happen first (they use atomic rename, so they either succeed or don't). DB operations are wrapped in a single transaction. This matches the existing write philosophy: if the transaction fails, orphaned files are safe and content is preserved.

```
1. Validate document (exists, deleted_at IS NULL)
2. Validate snapshot (exists, belongs to this document)
3. Read snapshot content from disk
4. Read current document content from disk
5. Write pre-restore snapshot file (atomic: tmp → fsync → rename)
6. Write restored content to document file (atomic: same pattern)
7. DB TRANSACTION:
   a. INSERT pre-restore snapshot row (reason = "pre-restore")
   b. UPDATE document: word_count, updated_at, last_snapshot_at
   c. UPDATE FTS index with restored plain text
8. Return updated document + pre_restore_snapshot_id
```

If step 7 fails (DB error), the files on disk have been updated but metadata is stale. This is the same failure mode as the existing document save — recoverable, content safe. The pre-restore snapshot file exists on disk even if its DB row wasn't inserted.

### API

```
POST /api/documents/:id/restore/:snapshotId

Response 200:
{
  document: { ...updatedDocMetadata },
  pre_restore_snapshot_id: "uuid-of-safety-snapshot"
}
```

### File

`src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts`

### Error cases
- 404 if document not found or deleted
- 404 if snapshot not found or doesn't belong to this document
- 404 if snapshot file missing from disk (warn but don't crash)

---

## Layer 2: Snapshot Panel UI

**Goal:** A slide-out panel in the workspace showing snapshot timeline for the active document.

### Design

The panel appears to the right of the editor (or overlays on mobile), triggered by a button in the editor footer. It shows a chronological list of snapshots, grouped by day.

```
┌─────────────────────────────────────────────────────┐
│  Sidebar  │  Editor                    │  Snapshots  │
│  (binder) │  [toolbar]                 │  ┌────────┐ │
│           │  [content]                 │  │ Today   │ │
│           │                            │  │  2:30pm │ │
│           │                            │  │  12:15  │ │
│           │                            │  │ Yester. │ │
│           │                            │  │  9:45pm │ │
│           │                            │  │  7:20pm │ │
│           │                            │  └────────┘ │
│           │  [footer: words | saved]   │             │
└─────────────────────────────────────────────────────┘
```

### State

In workspace page (`src/routes/novels/[id]/+page.svelte`):

```ts
let showSnapshots = $state(false);
let snapshots: SnapshotSummary[] = $state([]);
let previewingSnapshot: { id: string; content: string } | null = $state(null);
```

### Snapshot list

- Fetched from `GET /api/documents/:id/snapshots` when panel opens (or when active doc changes while panel is open)
- **Paginated:** Fetch first 50, "Load more" button at bottom for older snapshots
- Grouped by day using `created_at` timestamps
- Each entry shows:
  - **Time** — e.g. "2:30 PM" (today) or "Feb 18, 9:45 PM" (older)
  - **Word count** — e.g. "2,847 words"
  - **Reason badge** — "auto" / "manual" / "pre-restore" (subtle, different colors)
  - **Word count delta** — e.g. "+215" or "−42" vs the next older snapshot in the list. Computed client-side: for a DESC-sorted list, each entry's delta is `snap[i].word_count - snap[i+1].word_count`. Last entry in the list shows no delta.

### Snapshot preview

Click a snapshot → fetch its content from `GET /api/documents/:id/snapshots/:snapId` → display in a read-only view. The editor area shows a preview banner:

```
┌─────────────────────────────────────────────────┐
│ ⚠ Viewing snapshot from Feb 18, 9:45 PM         │
│ [Restore this version]  [Back to current]        │
└─────────────────────────────────────────────────┘
```

- **Preview renders via TipTap in read-only mode** (not raw `{@html}`). This applies the same ProseMirror schema as the editor, preventing XSS from imported or pasted content without needing a separate sanitizer. The read-only TipTap instance uses `editable: false`.
- "Back to current" dismisses the preview and returns to the live editor
- "Restore this version" calls the restore endpoint, then reloads the document

### Interaction flow

1. User clicks "Snapshots" button in editor footer → `showSnapshots = true`
2. Workspace fetches snapshot list → renders timeline panel
3. User clicks a snapshot → fetch content → show preview
4. User clicks "Restore" → confirm dialog → `POST /api/documents/:id/restore/:snapId` → reload doc in editor → close preview
5. User clicks "Back to current" → dismiss preview → return to live editor

---

## Layer 3: Integration with Editor

### Editor footer changes

Add a "Snapshots" button to the editor footer, next to the save status:

```svelte
<button class="snapshot-btn" onclick={onSnapshotsToggle}>
  Snapshots
</button>
```

The `onSnapshotsToggle` callback is passed from the workspace page to the Editor component as a new prop. The Editor doesn't manage snapshot state — it just surfaces the toggle.

### Props additions to Editor

```ts
onSnapshotsToggle?: () => void;
onManualSnapshot?: () => Promise<void>;
```

### Preview mode — Editor stays alive

**Critical:** Svelte's `{#if}` destroys and recreates components. Using `{#if !previewingSnapshot}` around the Editor would destroy the TipTap instance, losing unsaved edits and editor state. Instead:

- **Hide the Editor with CSS** (`display: none` or `visibility: hidden`) when preview is active
- Show the read-only TipTap preview in a sibling container
- The Editor remains mounted with its full state preserved

```svelte
<div class="editor-area">
  <!-- Live editor — hidden during preview, never destroyed -->
  <div class:hidden={!!previewingSnapshot}>
    <Editor ... />
  </div>

  <!-- Read-only preview — shown only during preview -->
  {#if previewingSnapshot}
    <div class="snapshot-preview">
      <div class="preview-banner">...</div>
      <SnapshotPreview content={previewingSnapshot.content} />
    </div>
  {/if}
</div>
```

### Autosave management during preview

The Editor's autosave timer continues running while hidden. This requires careful handling:

1. **Entering preview:** Flush the autosave — clear the pending timer, trigger an immediate save if status is `'unsaved'`, and `await` its completion before showing the preview.
2. **During preview:** The editor is hidden but alive. No user input reaches it, so no new changes accumulate and autosave won't fire (no `onUpdate` events). Safe.
3. **After restore:** The document content on disk has changed. Call `editor.commands.setContent(restoredHtml)` to update the live editor, then set `saveStatus = 'saved'`. This prevents the editor from auto-saving stale content.
4. **Exiting preview without restore:** Simply hide the preview div. The editor reappears with its preserved state.

New prop on Editor for flush:

```ts
/** Flush any pending save immediately. Returns when save completes. */
flushSave?: () => Promise<void>;
```

The workspace calls `await editorRef.flushSave()` before entering preview mode.

---

## Layer 4: Manual Snapshot Button

### Editor footer addition

Add a "snapshot" button to the editor footer (next to the Snapshots toggle). Calls the `onManualSnapshot` callback.

- Brief "Snapshot saved" indicator (reuse save-status styling, e.g. flash "Snapshot ✓" for 2 seconds)
- Updates the snapshot panel list if it's open
- Disabled while a save is in-flight

---

## Component Breakdown

### New files

| File | Purpose |
|------|---------|
| `src/routes/api/documents/[id]/restore/[snapshotId]/+server.ts` | Restore endpoint |
| `src/lib/components/SnapshotPanel.svelte` | Timeline panel component |
| `src/lib/components/SnapshotPreview.svelte` | Read-only TipTap preview |

### Modified files

| File | Changes |
|------|---------|
| `src/routes/novels/[id]/+page.svelte` | Add snapshot state, panel toggle, preview mode (CSS hide), restore flow |
| `src/lib/components/Editor.svelte` | Add `onSnapshotsToggle`, `onManualSnapshot`, `flushSave` props; snapshot button in footer |
| `src/lib/server/files.ts` | Change `snapshotPath` to use UUID filename; add `readSnapshotFile` helper |
| `src/lib/types.ts` | Add `SnapshotSummary` interface |
| `src/routes/api/documents/[id]/snapshots/+server.ts` | Transaction wrap, secondary sort, pagination (LIMIT/OFFSET) |
| `src/routes/api/documents/[id]/snapshots/[snapId]/+server.ts` | Add `deleted_at IS NULL` check |
| `src/routes/api/documents/[id]/+server.ts` | Use UUID in snapshot filename |

### No schema changes needed

The existing `snapshots` table has everything we need. The `reason` column already supports the `"pre-restore"` value.

---

## SnapshotPanel Component API

```svelte
<SnapshotPanel
  docId={activeDocId}
  snapshots={snapshots}
  activeSnapshotId={previewingSnapshot?.id}
  onPreview={(snapId) => { /* fetch + show preview */ }}
  onRestore={(snapId) => { /* confirm + restore */ }}
  onClose={() => { showSnapshots = false }}
  onLoadMore={() => { /* fetch next page */ }}
/>
```

### Day grouping logic

```ts
function groupByDay(snapshots: SnapshotSummary[]): Map<string, SnapshotSummary[]> {
  const groups = new Map<string, SnapshotSummary[]>();
  for (const snap of snapshots) {
    const date = new Date(snap.created_at);
    const key = isToday(date) ? 'Today'
      : isYesterday(date) ? 'Yesterday'
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(snap);
  }
  return groups;
}
```

### Word count delta

Computed client-side from the DESC-sorted list. For snapshot at index `i`, delta = `snap[i].word_count - snap[i+1].word_count`. Positive values display as "+N" (green), negative as "−N" (red). Last snapshot in the loaded list shows no delta.

If pagination is added later and the last loaded snapshot's delta is needed, the server can include one extra "boundary" item or the client can fetch `limit + 1` and display `limit`.

---

## SnapshotPreview Component

A thin wrapper around TipTap in read-only mode:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';

  let { content }: { content: string } = $props();
  let element: HTMLDivElement;
  let editor: Editor | null = $state(null);

  onMount(() => {
    editor = new Editor({
      element,
      extensions: [StarterKit],
      content,
      editable: false,
    });
  });

  onDestroy(() => editor?.destroy());
</script>

<div class="preview-content" bind:this={element}></div>
```

This reuses the same TipTap/ProseMirror schema as the live editor, so any content that was safe to edit is safe to preview. Malformed or dangerous HTML is stripped by ProseMirror's schema validation — no separate sanitizer needed.

---

## Styling

The snapshot panel follows existing design language:
- **Width:** 280px (same as sidebar), collapsible
- **Background:** `var(--bg-sidebar)` with `var(--border-strong)` left border
- **Day headers:** Uppercase, small, muted (like the "Trash" header in the binder)
- **Snapshot entries:** Hover highlight `var(--tree-hover)`, click highlight `var(--accent-bg)`
- **Active entry** (currently previewed): `var(--accent-bg)` persistent highlight
- **Reason badges:** Tiny pills — "auto" in `var(--text-muted)`, "manual" in `var(--accent)`, "pre-restore" in a warning color
- **Preview banner:** Warm amber background to clearly indicate non-live state
- **Restore confirmation:** Uses the existing modal pattern from the workspace
- **`.hidden` utility:** `display: none` class for hiding the editor during preview

### Mobile

On mobile (< 768px), the snapshot panel overlays the editor as a full-width slide-up sheet rather than a side panel.

---

## Restore Confirmation Dialog

Non-destructive but still important to confirm:

```
┌─────────────────────────────────────────┐
│  Restore to Feb 18 version?             │
│                                         │
│  Your current document will be saved    │
│  as a snapshot before restoring.        │
│  Nothing will be lost.                  │
│                                         │
│  [Cancel]  [Restore]                    │
└─────────────────────────────────────────┘
```

The modal has `aria-modal="true"` and uses the existing `.modal` / `.modal-backdrop` CSS from the workspace.

---

## Testing Strategy

### Functional tests (Vitest)

| Test | What it verifies |
|------|-----------------|
| Restore endpoint creates pre-restore snapshot | DB has new snapshot with reason "pre-restore" before content changes |
| Restore endpoint overwrites document content | Content file on disk matches snapshot content after restore |
| Restore endpoint updates word count + FTS | Document metadata and search index reflect restored content |
| Restore endpoint runs in transaction | All DB changes atomic (mock a failure mid-restore, verify rollback) |
| Restore rejects deleted documents | Returns 404 for soft-deleted docs |
| Restore rejects mismatched snapshot | Returns 404 if snapshot belongs to a different document |
| Snapshot list returns newest first with tiebreaker | `created_at DESC, id DESC` ordering verified |
| Snapshot list respects pagination | LIMIT/OFFSET returns correct page |
| Snapshot content read rejects deleted documents | `deleted_at IS NULL` enforced |
| Manual snapshot is transactional | INSERT + UPDATE in single transaction |

### Source-scanning tests

| Test | Pattern checked |
|------|----------------|
| Restore endpoint validates deleted_at | Source contains `deleted_at IS NULL` |
| Editor hidden with CSS, not destroyed | Source contains `class:hidden` (not `{#if}` around Editor) |
| Preview uses TipTap read-only | SnapshotPreview source contains `editable: false` |
| Restore confirmation uses modal | Source contains `aria-modal` for restore dialog |
| Snapshot filenames use UUID | `snapshotPath` does NOT use timestamp in filename |

---

## Deferred to later

- **Side-by-side diff view** — spec marks this as a stretch goal. Can be added as a "Compare" button in the preview banner. Would use a simple text diff library (e.g., `diff` or `jsdiff`). Not in this implementation.
- **Snapshot pruning/management** — preservation-first means no delete. Archivist purge is Phase 2.
- **Snapshot search** — searching within snapshot content. Low priority, FTS only indexes current content.
- **Content-path refactor** — currently snapshot paths are stored as full filesystem paths in the DB. Ideally the DB would store only the snapshot ID/filename and reconstruct the path using `getDataRoot()`. This avoids breakage if `DATA_ROOT` changes and eliminates a theoretical file-read vector via DB manipulation. Low priority — the paths are server-generated and validated. Deferred to a future cleanup pass.

---

## Dependency Graph

```
Layer 0 (existing bug fixes)     ← do first, independent
Layer 1 (restore endpoint)       ← depends on 0d (UUID filenames)
Layer 2 (snapshot panel UI)      ← depends on 0c, 0e (sort, types)
Layer 3 (editor integration)     ← depends on Layer 2
Layer 4 (manual snapshot button) ← depends on Layer 3, small addition
```

Layers 0, 1, and 2 can be partially parallelized.

---

## Review History

- **v0.1** — Initial implementation plan (Feb 20, 2026)
- **v0.2** — Revised after Codex + Gemini review. Changes:
  - Added Layer 0: existing bug fixes (snapshot deleted_at, manual snapshot transaction, sort tiebreaker, UUID filenames, SnapshotSummary type) (Codex #7, #8; Gemini #4, #6)
  - Editor hidden with CSS during preview instead of `{#if}` destruction (Codex #1 — best catch)
  - Preview uses TipTap in read-only mode instead of raw `{@html}` to prevent XSS (Codex #2)
  - Explicit autosave pause/flush protocol for preview mode (Codex #3)
  - Restore endpoint: specified transaction boundaries and file-then-DB ordering (Codex #4, Gemini #1)
  - Snapshot filenames changed from timestamp to UUID to prevent collisions (Codex #5)
  - Added pagination (LIMIT 50 + load more) for snapshot list (Codex #6)
  - Clarified word count delta direction (DESC list: `snap[i] - snap[i+1]`) (Codex #9)
  - Added SnapshotPreview component (read-only TipTap) to component breakdown
  - Added content-path refactor to deferred items (Gemini #3 — defense-in-depth, low priority)
  - Rejected Gemini #2 (search leak in deleted novels): `softDeleteNovel` already cascades `deleted_at` to all documents; existing `d.deleted_at IS NULL` check is sufficient

---

*Companion to `spec.md` v0.4. Phase 1a implementation plan v0.2.*
