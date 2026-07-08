# UX & Writing-Statistics Ideas

**Date:** 2026-07-08
**Status:** Planning — nothing here is implemented. Written to be executable by any engineer/model without further context.
**Personas:** the **writer** (short, snatched writing sessions — minutes matter, friction kills momentum) and the **archivist** (runs the instance, loves data and statistics).
**Companion docs:** [remediation-plan-2026-07.md](remediation-plan-2026-07.md) (*RP*), [mvp-plan.md](mvp-plan.md). Nothing below blocks MVP; items marked ★ are strong candidates to ride along shortly after launch.

Effort key: **S** = an hour or two, **M** = an afternoon-ish, **L** = multi-day.

---

## Tier 1 — Quick wins (writer-facing friction removal)

### 1.1 ★ Unified, discoverable rename — and add it for documents/folders at all (S–M)
**Current state (verified):** novels rename in two places with two different gestures — library card via a hover-revealed ✎ button ([+page.svelte](../src/routes/+page.svelte) ~line 255) and workspace sidebar via double-click on the title (~line 494). Documents and folders have **no rename UI anywhere**: the PATCH endpoint (`/api/novels/:id/tree/nodes/:nodeId` with `{title}`) supports it, but the binder offers only "+" and "×" and the editor header is a static `<h1>`. A writer cannot rename a chapter.

**Known ergonomic problems to fix, not replicate:** the library card is wrapped in an `<a>`, so the whole surface reads as "open" and the tiny pencil competes with navigation; commit-on-blur ("click off to save") feels accidental rather than intentional; double-click is undiscoverable and unavailable on touch.

**Spec — one pattern everywhere (novel cards, sidebar title, tree items, editor header):**
- Hover (or long-press on touch) reveals a ✎ button — same affordance at every level; ✎ is the *only* rename trigger (keep double-click as a bonus shortcut on non-link surfaces, drop it as the primary).
- Clicking ✎ swaps the title for an inline input, pre-filled and select-all'd, with a visible accent border so the mode change is unmistakable.
- **Enter commits. Escape cancels. Blur cancels** (not commits) — click-off never silently saves; unsaved edits are simply discarded, which is safe because Enter is the explicit commit. (This reverses today's blur-commit behavior on novel renames — change those two call sites to match.)
- While editing inside an `<a>` card or a tree row, `preventDefault`/`stopPropagation` on click and keydown so navigation and doc-opening can't hijack the interaction (the Enter-in-`<a>` trap is already known).
- On document rename: update `activeDoc.title`, the tree node, and rely on the PATCH endpoint's existing FTS title update. On the editor header: same input pattern, tab-reachable.

Test: existing PATCH tests cover the API; add a source-grep test asserting tree items render a rename control and that no rename input commits on blur.

### 1.2 ★ Resume where I left off (S)
For a ten-minutes-at-a-time writer, landing on "Select a document from the binder" is a tax. Persist last-active doc per novel in `localStorage` (`scriptorium-last-doc-{novelId}`) on `selectDocument`; on workspace mount, if the stored id exists in the loaded tree (non-deleted), auto-select it. Bonus (S): store and restore the editor scroll position (`scrollContainer.scrollTop`) the same way. Zero schema, zero API.

### 1.3 ★ Words-today in the editor footer (S, client-only version)
Footer already shows total/selection counts. Add "+N today": track `sessionStartCount` per doc on load and accumulate deltas in `localStorage` keyed `scriptorium-words-{date}` (date = local YYYY-MM-DD). Honest disclaimer in code: client-side counting is approximate across devices — the real version is Tier 2's `writing_days` table; build this only as the placeholder if Tier 2 is deferred, and remove it when 2.1 lands.

### 1.4 Novel progress bars (S)
`novels.word_count_target` exists in the schema and is settable via PUT, but no UI reads or writes it. Add: target input on the library card (edit affordance) and a thin progress bar (total_word_count / target) on the card + a compact "62,410 / 80,000" in the workspace sidebar header. Skip when target is NULL.

### 1.5 Local draft rescue (M) — cheap insurance until Phase 3 offline
If a save PUT fails (network blip), stash `{docId, html, ts}` to `localStorage` (`scriptorium-rescue-{docId}`); clear on successful save. On document open, if a rescue entry exists and is newer than the server's `updated_at`, show a banner: "You have unsaved changes from {time} recovered on this device — Restore / Discard". This also softens the flush-fails-during-doc-switch edge left after RP P0-1. Not a sync system — single-device, last-writer-wins, explicitly labeled as a rescue.

### 1.6 Installable app icon / PWA manifest (S)
Manifest + icons so the app installs to a phone/tablet home screen (standalone window, no browser chrome). **Deliberately no service worker yet** — offline is spec Phase 3, and a half-done SW poisons caches. Some browsers won't offer install without a SW; accept that. Files: `static/manifest.webmanifest`, icons (192/512, warm parchment/ink to match the theme), `<link rel="manifest">` in `app.html`.

---

## Tier 2 — Writing statistics (the archivist's axis)

**The goldmine already exists:** the `snapshots` table stores `(document_id, word_count, reason, created_at)` for every autosave ≥2 min apart since day one. Historical words-over-time is *derivable retroactively* with zero new instrumentation. Precise daily added/deleted counts need one new table going forward.

### 2.1 ★ `writing_days` table — the stats backbone (M; needs RP P2-6 migrations first)
```sql
CREATE TABLE writing_days (
  user_id     TEXT NOT NULL REFERENCES users(id),
  novel_id    TEXT NOT NULL REFERENCES novels(id),
  day         TEXT NOT NULL,           -- local YYYY-MM-DD (see note)
  words_added INTEGER NOT NULL DEFAULT 0,  -- sum of positive save deltas
  words_removed INTEGER NOT NULL DEFAULT 0,-- sum of |negative| deltas
  saves       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, novel_id, day)
);
```
Hook: in the document PUT handler, inside the existing transaction, compute `delta = newWordCount - doc.word_count` and upsert. Skip zero deltas. **Timezone note:** store the day computed with a configurable `STATS_TZ` (env, default the server's TZ) — daily stats that flip at 4 pm because of UTC are worse than none. Backfill migration: derive best-effort historical rows from snapshot word-count deltas per document per day (attribute to the novel; user_id = the writer if only one exists, else NULL-safe skip).

### 2.2 ★ Stats pages (M–L)
- `/novels/[id]/stats`: daily words bar chart (last 60 days), cumulative words line vs. target line, per-chapter word-count bars (from `documents.word_count`, binder order), personal records (best day, best week), total snapshots.
- `/stats` (library level): all novels stacked, plus the heatmap (2.3).
- **Pace projection** (the archivist will love this): rolling 30-day mean of `words_added`; "at this pace you reach {target} around {date}". Show honestly — hide when pace ≈ 0.
- **Charts: no dependencies.** Bars, lines, and heatmaps are trivial inline SVG in small Svelte components (`<StatsBars>`, `<StatsLine>`, `<Heatmap>`), themed via the existing CSS custom properties. Do not add a charting library to an app this lean.
- CSV export button per view (`/api/novels/:id/stats.csv`) — data people want the raw table.

### 2.3 ★ Calendar heatmap + streaks, designed for a busy parent (M)
GitHub-style year grid colored by `words_added`. Streak chip ("7-day streak / best: 23") **with kind mechanics**, configurable per user: a day "counts" at a low threshold (default ≥50 words), and offer a *weekly* goal mode (e.g. "3 writing days a week") as the default framing instead of daily streaks — daily streaks punish exactly the person this app is for. Never show a broken-streak message; show "best" and "this week" instead.

### 2.4 Writing sprints (M, optional)
Footer "Sprint" button: pick 10/15/25 min + optional word goal; countdown in footer; at the end, show words added (from the session delta already tracked for 2.1) and log `sprints` count onto the day's row. Entirely client + one extra column. Pairs well with focus mode (3.4).

---

## Tier 3 — Scrivener-parity features

### 3.1 ★ Document status labels (M; needs migrations)
`documents.status TEXT DEFAULT NULL` with a fixed vocabulary (`idea | draft | revised | final`) — colored dot in the binder, selector in the inspector (3.2), filter chip above the tree. The .scriv importer already parses Scrivener's `StatusID`/`LabelID` maps and **throws them away** ([scriv.ts](../src/lib/server/import/scriv.ts) lines 96–112) — map common Scrivener statuses onto ours at import. Compile dialog gains an optional "only include status ≥ revised" filter later.

### 3.2 Inspector panel (M)
Right-side panel (toggle like the snapshot panel) for the active doc: **synopsis** (schema field exists — no UI reads or writes it today), status (3.1), per-doc word target, created/updated, snapshot count with a link that opens the snapshot panel. PUT already accepts `synopsis`. This is the doorway to corkboard later (cards = synopses).

### 3.3 ★ Snapshot diff — "what changed since Tuesday" (M)
All the machinery exists: jsdiff word-level diffing in [compare/diff.ts](../src/lib/server/compare/diff.ts) and the [DiffView](../src/lib/components/DiffView.svelte) component. Add `GET /api/documents/:id/snapshots/:snapId/diff` (snapshot plaintext vs. current plaintext, reuse `computePairDiff`) and a "Compare to current" button in the snapshot panel rendering DiffView. This turns the snapshot system from insurance into a visible superpower, and it's the cheapest high-wow item in this document.

### 3.4 Focus / composition mode (M) — pull forward from spec Phase 5
Full-viewport editor: hide sidebar + header, generous measure, footer reduced to word count + exit. Optional typewriter scrolling (keep caret vertically centered — ProseMirror: scroll `coordsAtPos(selection.head)` to container midpoint on transaction). Esc exits. For someone writing in stolen minutes, instant immersion is the feature.

### 3.5 Import Word documents (M)
Pandoc is already a server dependency — run it in reverse: upload `.docx` → `pandoc -f docx -t html` → create document(s). UI: "Import Word file" on the novel workspace (per-doc) and library (novel-from-docx, split on H1s). Mind upload size limits and run pandoc with the same spawn-argv hygiene as compile. Many writers have Word files, not Scrivener bundles; this widens the on-ramp considerably.

### 3.6 Writer-facing "Download my novel" (S–M)
Zip of the novel: assembled HTML + per-doc files + snapshots (use a small zip lib or `archiver`; stream the response). Distinct from admin backups: this is the writer's *ownership* button — "your words are yours, take them anytime." Preservation-first apps should wear that on the UI.

---

## Small tweaks (sweep opportunistically)

- **Keyboard map:** Ctrl+S → manual snapshot (browsers eat it for "save page" — preventDefault), Ctrl+Shift+F → search (Ctrl+K exists), Esc closes panels consistently.
- **Binder a11y:** items use `role="treeitem"` without a `role="tree"` container or arrow-key navigation — either complete the WAI-ARIA tree pattern (M) or drop the roles to stop promising what isn't there (S).
- **Search ranking:** default FTS5 rank treats title and body equally; `bm25(documents_fts, 10.0, 1.0)` weights title hits up. One-line change, test with a common word.
- **Empty states:** first-novel and first-document screens should teach ("Create your first chapter — everything autosaves, and snapshots keep history"). Costs a paragraph, saves an onboarding call.
- **Word-count badge** hides at 0 via `{#if node.word_count}` — falsy trap; show "0" or an em-dash for empty docs so they're visibly empty.

## Suggested order & dependencies

| Order | Item | Effort | Depends on |
|-------|------|--------|-----------|
| 1 | 1.1 rename UI | S | — |
| 2 | 1.2 resume last doc | S | — |
| 3 | 3.3 snapshot diff | M | — |
| 4 | 1.4 progress bars | S | — |
| 5 | RP P2-6 migrations scaffold | M | — (unblocks all schema work) |
| 6 | 2.1 writing_days + backfill | M | migrations |
| 7 | 2.2 + 2.3 stats pages & heatmap | M–L | 2.1 |
| 8 | 3.1 status labels → 3.2 inspector | M each | migrations |
| 9 | 1.5 draft rescue, 1.6 PWA, 3.4 focus mode | S–M | — |
| 10 | 3.5 docx import, 3.6 download-my-novel, 2.4 sprints | M | — |

Everything above stays true to the house style: single Node process, SQLite, no client framework additions, no charting libraries, warm theme via existing CSS variables.
