# Library Collections — Collapsible Sections (Spec)

**Status:** spec complete
**Written:** 2026-07-10
**Relation to roadmap:** first slice of `ux-and-stats-ideas.md` Tier W.4 (Worlds) —
the library-grouping half, without era labels/timeline/character scoping. Named
"collections" rather than "worlds" because sections like *Poetry* aren't worlds;
if W.4 formalizes later, worlds can build on or beside this.

## Goal

The library groups novels under user-defined, collapsible sections ("Tigrenache
Universe", "Poetry", …). Users can create, rename, reorder, and delete
collections, and move novels between them — by drag-and-drop on desktop and by
an explicit menu on touch. Novels without a collection appear in a trailing
**Unsorted** section.

## Schema (guarded migration, same pattern as `owner_id`/`import_source`)

```sql
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- novels gains: collection_id TEXT REFERENCES collections(id)  (nullable)
```

Collections are global (two-user household; owner shelf-chips already slice the
library per person and compose with sections). No soft-delete: deleting a
collection nulls its novels' `collection_id` (they fall to Unsorted) — the
novels themselves are never touched.

## API (validation in the P1-5/P1-6 explicit style)

- `GET /api/collections` — ordered by `sort_order`.
- `POST /api/collections` `{title}` — 400 on empty/whitespace title; sort_order
  appended at end.
- `PUT /api/collections/[id]` `{title?, sort_order?}` — 404 unknown id, 400 bad
  fields.
- `DELETE /api/collections/[id]` — nulls member novels' collection_id, then
  deletes. 404 unknown id.
- Novel assignment: extend existing `PUT /api/novels/[id]` with `collection_id`
  — must be an existing collection id or explicit `null` (unassign); 400
  otherwise. (Same COALESCE-style optionality as the other fields; note `null`
  must be distinguishable from "omitted" — use a sentinel check on key presence.)
- All `requireUser`; no role gating (no permission enforcement exists yet;
  archivist-only gating can ride the C.1 matrix later).

## Library UI

- **Sections** render in `sort_order`, each with a header: chevron (▸/▾),
  title, novel count, then the section's novel cards in the existing grid.
  **Unsorted** renders last (only when non-empty), not backed by a DB row.
- **Collapse state** per section persisted in localStorage
  (`scriptorium-collections-collapsed`), SSR-guarded like the other prefs.
- **Owner shelf chips** (All/Mine/per-owner) keep working: they filter cards
  *within* sections; a section empty under the current filter hides.
- **Assignment:**
  - Drag a novel card onto a section header (HTML5 DnD; `draggable` on the
    card wrapper — mind the card's `<a>` navigation, suppress click after
    drag). Drop targets highlight.
  - Touch/menu fallback: a "Move to…" control on the card (same interaction
    weight as the rename pencil / status chip, always visible on
    `pointer: coarse`) opening a small list of collections + Unsorted.
- **Manage collections:** an "Edit sections" affordance in the library header
  opens a modal: create (input + button), rename inline, reorder (↑/↓ swap
  sort_order), delete (confirm dialog naming the count of novels that will
  fall to Unsorted). Match existing modal patterns and CSS variables; both
  themes.
- Novel create/import: untouched — new novels land Unsorted (a target-picker
  can come later per roadmap C.2 shelf ideas).

## Tests (red-green)

- Endpoints: title validation, 404s, delete-nulls-members, assignment
  validation (unknown id 400, null unassigns, omitted no-ops).
- Migration: legacy DB gains table + column (mirror the owner_id migration
  test).
- UI: house source-grep pattern — sections render, chevron toggle, localStorage
  key, DnD handlers, move-to fallback, manage modal.

## Sizing

One unit (M/L). Server portion is small; the library page rework is the bulk.

## Out of scope

- Era labels, timeline ordering, world-scoped characters (W.4 proper).
- Per-owner collection namespaces.
- Nested collections.
- Reassigning docs between novels (this is novel-level grouping only).
