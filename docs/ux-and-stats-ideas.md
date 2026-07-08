# UX & Writing-Statistics Ideas

**Date:** 2026-07-08
**Status:** Planning — nothing here is implemented. Written to be executable by any engineer/model without further context.
**Personas:** the **writer** (short, snatched writing sessions, **often on her phone** — minutes matter, friction kills momentum, touch is the primary input) and the **archivist** (runs the instance, loves data and statistics, and is consolidating a large pile of raw drafts into order).
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

## Tier M — Mobile & touch (the writer's primary device)

The writer will often work from a phone. The responsive layout exists (≤768 px: sidebar becomes a full-height overlay), but **three current patterns don't degrade on touch — they disappear.** Treat M.1–M.3 as launch-relevant (see the mobile additions to [mvp-plan.md](mvp-plan.md)); the rest is fast-follow polish.

### M.1 ★ Collapsed sidebar strands phone users (S) — *bug, verified in code*
The only expand/collapse control is `.sidebar-toggle`, rendered **inside** the sidebar ([novels/[id]/+page.svelte](../src/routes/novels/[id]/+page.svelte) ~line 496). On mobile, `.sidebar.collapsed` is `transform: translateX(-100%)` — the whole aside, toggle included, leaves the screen. Collapse the binder on a phone and there is no way to reopen it (desktop keeps a 40 px rail, so it's mobile-only). Fix: a hamburger/binder button in the editor area (header or floating) shown at mobile widths whenever the sidebar is closed; also close the overlay when a document is selected (currently it stays open over the editor) and on backdrop tap.

### M.2 ★ Hover-revealed actions are unreachable on touch (S–M)
`.node-actions { display:none }` + `.tree-item:hover` means add/trash (and the rename ✎ this doc proposes) rely on hover, which touch lacks. Adopt one rule: **at `@media (pointer: coarse)`, nothing load-bearing hides behind hover.** Give each tree row a visible ⋯ button opening a small action sheet (Rename / New document / Move… / Trash). Desktop keeps hover-reveal; the ⋯ pattern can serve both if it proves cleaner than scattered micro-buttons.

### M.3 ★ Drag-and-drop reorder has no touch equivalent (M)
HTML5 drag events don't fire on iOS/Android browsers — reordering and re-parenting are desktop-only today. Don't polyfill; add an explicit **Move…** action (from the M.2 sheet): dialog lists folders + "top/bottom/after {sibling}", calls the existing reorder PUT. Honest, predictable, screen-reader-friendly — and useful on desktop too.

### M.4 Virtual-keyboard & viewport correctness (S)
`.workspace { height: 100vh }` misbehaves on mobile (URL bar, on-screen keyboard overlap the toolbar/footer). Use `100dvh` with a `100vh` fallback line before it; add `interactive-widget=resizes-content` to the viewport meta for Android; verify the editor scroll container — not the page — scrolls while typing. Defer `visualViewport` tricks unless testing shows the toolbar still sinks under the keyboard.

### M.5 Tap-target pass (S)
`.btn-tiny`, `.folder-toggle`, and footer buttons are well under the ~44 px comfortable minimum. At `pointer: coarse`, bump padding/hit areas (padding growth, not font growth — keep the visual density on desktop). Rename inputs (1.1): on touch, autofocus + select-all so the keyboard appears immediately.

### M.6 Real-device acceptance pass (process, not code)
One scripted session on an actual phone (iOS Safari + Android Chrome): log in → open novel → **collapse and reopen binder** → create doc → write a paragraph → rename it → trash and restore it → check footer/toolbar with keyboard open → export docx. Added to the MVP launch checklist; repeat after any layout-touching change.

---

## Tier N — Getting in and around (library ↔ editor navigation)

### N.1 ★ "Continue writing" (S)
Pairs with 1.2: the library shows a hero button — "Continue: *{doc title}* in *{novel}*" — jumping straight to the last-edited document. Login → one tap → typing. Optional per-user setting to skip the library entirely on login. For a snatched-minutes writer this is the single highest-leverage navigation change.

### N.2 Recent documents on the library (S)
Under the hero: last 5 edited docs across novels (`documents ORDER BY updated_at DESC`, non-deleted, joined to novel titles). Tap → workspace with that doc active (workspace reads a `?doc=` query param — also gives every document a shareable/bookmarkable URL, which the writer can pin to her phone home screen alongside the PWA icon).

### N.3 Next/previous chapter buttons (S)
Editor header (or footer) ‹ › stepping through binder order (reuse the compile tree-walk's flatten logic client-side). On a phone — where the binder is a full-screen overlay — moving between adjacent chapters without opening the drawer is a big comfort win.

### N.4 Dynamic tab titles (S)
`<svelte:head><title>{doc} — {novel} — Scriptorium</title></svelte:head>`. Costs minutes; makes browser tabs, history, and PWA task-switcher legible.

### N.5 Archive shelf for novels (S–M) — *matters for the draft-triage workflow below*
When dozens of imported drafts land in the library, active writing drowns. `novels.status` already exists (`draft` by default) — add `archived` as a value, an Archive/Unarchive action on the card menu, and a default library filter of non-archived with an "Archived (23)" shelf below. No schema change. (Distinct from trash: archived novels are alive, searchable, and comparable — just shelved.)

### N.6 Quick-open (M, desktop nicety — do last)
Ctrl+P fuzzy switcher over doc titles across open novel (or library-wide). Keyboard-first desktop affordance; skip on mobile.

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

## Tier T — Draft triage at scale (order from chaos)

The archivist's real workflow: batch-import a **large pile** of raw .scriv drafts of the same novel(s), then figure out what's duplicate, what's variant, and what's canonical. The current compare feature (pick novel A vs. B → wizard) is built for two drafts, not twenty. These build on it in cost order — T.1 alone dissolves most of the chaos.

### T.1 ★ Exact-duplicate report (M) — do this first
Most chapters across sibling drafts are byte-identical; proving that cheaply collapses the problem. `GET /api/triage/duplicates?novels=id,id,…` (or all non-archived): for every non-deleted document in scope, compute SHA-256 of **normalized plaintext** (`stripHtml` → lowercase → collapse whitespace), group by hash, return clusters with >1 member (doc, novel, title, word count, updated_at). UI: a report page — "Chapter 7 is identical across *Draft3*, *Draft-final*, *DRAFT-FINAL-2*" — with links. No schema change needed at this scale (hundreds of docs × ~50 KB reads is a couple of seconds); if it feels slow later, persist `documents.content_hash` maintained on save (needs migrations, RP P2-6).

### T.2 Near-duplicate clustering (L)
Same report, fuzzy: cluster docs with Jaccard ≥ ~0.7 that aren't exact dupes ("*probably the same chapter, lightly revised*"). Naïve all-pairs Jaccard over ~1,000+ docs is too slow; the plan that stays simple: (1) exact-hash groups from T.1 collapse to one representative each; (2) skip pairs whose word counts differ >2×; (3) MinHash signatures (hash each word, keep the 128 smallest per doc) to *estimate* similarity, computing true Jaccard only for candidate pairs estimated ≥0.5; (4) union-find into clusters. All standard, no dependencies. Output: clusters ranked by size, each expandable into pairwise diffs.

### T.3 Canonical alignment cockpit (L) — the order-from-chaos view
Pick one novel as **canonical**; for each of its chapters, show every variant found across the other selected drafts (via T.1/T.2 matching, generalized from `matchDocuments`' two-novel form), ranked by similarity, with word counts and dates. Row actions: *open diff* (existing DiffView), *keep both as variant* (existing variant-folder mechanics from merge), *dismiss*. Unmatched leftovers listed at the end. This deliberately produces **decisions recorded against the canonical novel** rather than yet another merged copy — the existing merge wizard remains for true two-draft merges.

### T.4 Persist comparison sessions (M) — also closes RP P3-7 properly
Triage across twenty drafts won't finish in one sitting. Persist a `comparisons` row (id, params JSON, matched doc-id pairs JSON, decisions JSON, updated_at — needs migrations) so match results and per-pair decisions survive navigation. Merge/apply then validates against **stored document IDs**, not recomputed array indices — eliminating the index-shift hazard flagged in RP P3-7 instead of patching it.

### T.5 Diff performance guardrails (S–M)
`diffWords` degrades badly on long, heavily-divergent chapters (worst cases: seconds to minutes, blocking the event loop server-side). Two cheap guards: paragraph-level diff first, word-level only within changed paragraphs (classic two-phase); and a size gate (plaintexts > ~150 KB get paragraph-level only, with a "large document — coarse diff" note). Do this before T.3 invites bulk diffing.

### T.6 Import provenance (S)
When twenty near-identical novels arrive, "which file did this come from?" matters. Batch import already knows the source path — record it (audit log `details` today; a `novels.source_path` column once migrations exist) and show it in the library card tooltip / triage views. Also stamp `Imported {date} from {basename}` into the novel subtitle at import time as a zero-schema interim.

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

### 3.7 ★ Characters & concordance (M–L; needs migrations) — Phase 4 pull-forward, concordance-first
The request: add characters **with aliases** and see where they appear in the text. The design principle that keeps it light: **detection, not tagging** — the writer never annotates anything; mentions are found from the text.

- **Schema:** `characters (id, novel_id, name, notes, created_at, updated_at, deleted_at)` + `character_aliases (id, character_id, alias)`. `novel_id` nullable later for cross-novel/world scope (spec Phase 4); start novel-scoped.
- **Detection:** for each name/alias, doc-level hits via the existing FTS index (phrase query, handles multi-word names), then exact per-doc counts with a case-insensitive word-boundary scan of the plaintext. No stored occurrence table — computed on view, cached in memory per request. Aliases make this robust to "Bob / Bobby / Robert"; overlapping aliases across characters get flagged in the UI rather than guessed at.
- **UI:** a Characters panel per novel: list with mention totals; click one → occurrences grouped by chapter with `snippet()`-style context; **a mentions-per-chapter bar strip** — effectively a character screen-time chart across the book (and across *drafts*, which turns this into a triage tool too: "which draft still has the Mira subplot?").
- **Editor tie-in (S add-on):** a "highlight character mentions" toggle reusing the existing ProseMirror decoration plugin from search-highlight — pick a character, see them glow through the chapter.
- **Deliberately deferred:** profiles/photos/relationship graphs (Phase 4 spec), and *rename-character-across-manuscript* — writers ask for it and it's a foot-gun; if ever built, it must snapshot first and present a per-occurrence review checklist, never a blind replace.

### 3.8 Editorial margin notes (M–L) — built for exactly this two-person setup
The archivist reads drafts and needs to leave notes the writer sees in place: "this version of the ending is stronger," "duplicate of ch. 12?" A lightweight comments layer: `comments (id, document_id, user_id, anchor_from, anchor_to, body, resolved_at, created_at)` with TipTap marks for the anchor ranges; sidebar list + inline highlight; resolve/unresolve; no threading, no @-mentions, no realtime — it's sisters passing notes, not Google Docs. Positions drift as text changes — anchor via ProseMirror positions mapped through saved steps is overkill here; store text-quote anchors (prefix/exact/suffix) and re-locate on load, flagging orphaned notes rather than guessing.

### 3.9 Find & replace in a document (S–M)
Notably absent for a writing app, and cheap: search within the active doc using the same decoration machinery, next/prev, replace/replace-all via ProseMirror transactions (which keeps undo history intact — one Ctrl+Z reverses a replace-all). Case-sensitivity toggle; whole-word toggle. Novel-wide replace is *not* included (see 3.7's foot-gun note) — novel-wide **find** already exists via Ctrl+K.

---

## Small tweaks (sweep opportunistically)

- **Keyboard map:** Ctrl+S → manual snapshot (browsers eat it for "save page" — preventDefault), Ctrl+Shift+F → search (Ctrl+K exists), Esc closes panels consistently.
- **Binder a11y:** items use `role="treeitem"` without a `role="tree"` container or arrow-key navigation — either complete the WAI-ARIA tree pattern (M) or drop the roles to stop promising what isn't there (S).
- **Search ranking:** default FTS5 rank treats title and body equally; `bm25(documents_fts, 10.0, 1.0)` weights title hits up. One-line change, test with a common word.
- **Empty states:** first-novel and first-document screens should teach ("Create your first chapter — everything autosaves, and snapshots keep history"). Costs a paragraph, saves an onboarding call.
- **Word-count badge** hides at 0 via `{#if node.word_count}` — falsy trap; show "0" or an em-dash for empty docs so they're visibly empty.

## What we're deliberately NOT adding

Kept out on purpose — each would tax the two real users to serve imaginary ones:

- **Real-time collaboration / multiplayer cursors** — sisters passing notes (3.8) covers the actual workflow; CRDTs would dominate the codebase.
- **AI writing/suggestion features** — this is a preservation tool for *her* words.
- **Gamification beyond gentle stats** — no XP, no shame mechanics, no fire emojis guilt-tripping a busy mom (2.3's kind streaks are the ceiling).
- **Rich formatting** (fonts, colors, per-paragraph styles) — manuscripts are structure + prose; formatting belongs to compile output.
- **Plugin system / theming marketplace** — extend by editing the app; it's yours.
- **Novel-wide replace-all** — foot-gun (see 3.7/3.9); per-doc replace with intact undo only.
- **Native mobile apps** — the PWA + Tier M pass is the mobile story; two app stores is a part-time job.
- **Kanban/plotting boards, mind maps** — corkboard (via 3.2 synopses) is as far as visual planning goes unless real demand appears.

## Suggested order & dependencies

| Order | Item | Effort | Depends on |
|-------|------|--------|-----------|
| 1 | M.1 sidebar stranding fix, M.2 touch actions, M.4 dvh — with 1.1 rename (same surfaces) | S–M | — |
| 2 | 1.2 resume last doc + N.1 continue-writing + N.4 tab titles | S | — |
| 3 | T.1 exact-duplicate report + T.6 provenance + N.5 archive shelf | M | — (unblocks the triage workflow) |
| 4 | 3.3 snapshot diff + T.5 diff guardrails | M | — |
| 5 | 1.4 progress bars, N.2 recent docs, N.3 next/prev chapter, M.5 tap targets | S each | — |
| 6 | RP P2-6 migrations scaffold | M | — (unblocks all schema work) |
| 7 | 2.1 writing_days + backfill | M | migrations |
| 8 | 2.2 + 2.3 stats pages & heatmap | M–L | 2.1 |
| 9 | 3.7 characters & concordance | M–L | migrations |
| 10 | 3.1 status labels → 3.2 inspector | M each | migrations |
| 11 | T.4 persisted comparisons → T.2 clustering → T.3 alignment cockpit | M→L→L | migrations; T.1 |
| 12 | 1.5 draft rescue, 1.6 PWA, 3.4 focus mode, 3.9 find & replace | S–M | — |
| 13 | 3.5 docx import, 3.6 download-my-novel, 3.8 margin notes, 2.4 sprints, N.6 quick-open | M | — |

Everything above stays true to the house style: single Node process, SQLite, no client framework additions, no charting libraries, warm theme via existing CSS variables.
