# Library Collections v2 — Universes, Eras, and Shelves (Spec)

**Status:** spec complete (v2 — supersedes the flat-sections v1 before implementation began)
**Written:** 2026-07-10
**Relation to roadmap:** first slice of `ux-and-stats-ideas.md` Tier W.4 (Worlds).
The operator's framing: most of the author's novels share one big universe, the
way Sanderson's Cosmere contains Mistborn Era 1, Era 2, etc. The library should
read as a **bookshelf**: a universe heading, era sections beneath it, and sibling
versions of the same book visually stacked together.

## Model

Three concepts, two of them schema:

1. **Collections** — user-defined sections, ONE level of nesting:
   a top-level collection ("The Silvers Universe", "Poetry") may have child
   collections ("Tigrenache Era", "Ghaeran Era"); children cannot have children.
2. **Novel → collection assignment** — a novel may sit in any collection,
   top-level or child. Unassigned novels appear in a trailing **Unsorted**
   section.
3. **Stacks** (visual only, no new table) — novels in the *same collection*
   sharing a `stack_label` render as one clustered "stack" on the shelf (the
   three Away-Away-shaped novels leaning together), expandable in place.

## Schema (guarded migration, same pattern as `owner_id`/`import_source`)

```sql
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id),  -- null = top-level; one level max
  sort_order REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- novels gains: collection_id TEXT REFERENCES collections(id)  (nullable)
-- novels gains: stack_label TEXT                               (nullable)
```

Global (two-user household; owner shelf-chips compose as filters). No
soft-delete for collections. Deleting a collection: member novels'
`collection_id` → NULL (fall to Unsorted); child collections' `parent_id` →
NULL (promote to top-level). Novels themselves are never touched.

## API (validation in the P1-5/P1-6 explicit style; all `requireUser`)

- `GET /api/collections` — full list ordered by (parent grouping, sort_order).
- `POST /api/collections` `{title, parent_id?}` — 400 empty title; if
  `parent_id` given it must exist AND itself be top-level (one level max),
  else 400. sort_order appended at end among its siblings.
- `PUT /api/collections/[id]` `{title?, parent_id?, sort_order?}` — 404 unknown
  id; parent_id rules as above, plus a collection that HAS children cannot be
  given a parent (400); explicit `parent_id: null` promotes to top-level.
  Distinguish omitted vs null by key presence.
- `DELETE /api/collections/[id]` — the null/promote semantics above, then
  delete. 404 unknown.
- Novel assignment: extend existing `PUT /api/novels/[id]`:
  - `collection_id` — existing collection id or explicit null; 400 otherwise.
  - `stack_label` — non-empty string (trimmed) or explicit null; 400 otherwise.
  - Both distinguish omitted (no-op) from null (clear) by key presence.

## Library UI — the shelf

- **Rendering order:** top-level collections by sort_order; under a universe:
  its directly-assigned novels first (one shelf), then each child era (its own
  shelf); then the next top-level; **Unsorted** last (only when non-empty).
- **Headers:** top-level headers are large with a chevron (▸/▾); child-era
  headers smaller, indented, own chevron. Collapsing a universe hides its eras;
  era collapse state is independent and remembered. Collapse state in
  localStorage (`scriptorium-collections-collapsed`), SSR-guarded.
- **Shelf look:** each section's novels sit on a shelf — a horizontal baseline
  under each card row (CSS: a subtle thick underline/gradient in `--border`/
  surface tones with a soft shadow, evoking a wooden shelf without images).
  Works in both themes via CSS variables only. Tasteful > literal: the goal is
  "bookshelf feeling", not skeuomorphic wood texture.
- **Stacks:** novels sharing `stack_label` within a collection render as one
  stack: up to 3 card edges peeking behind the front card (CSS offset
  pseudo-elements or stacked wrappers), a label chip ("Away, Away — 3
  versions"). Clicking the stack expands it in place to a row of its member
  cards (collapse again via the same control). Expanded state need not persist.
  The front card is the most recently updated member.
- **Owner chips** (All/Mine/per-owner) filter cards within sections; sections
  (and stacks) empty under the filter hide.
- **Assignment interactions:**
  - Drag a card onto any universe or era header → assigns `collection_id`
    (HTML5 DnD, desktop enhancement; suppress the card's `<a>` navigation on
    drag-end; drop targets highlight).
  - Card "Move to…" control (always visible on `pointer: coarse`, same weight
    as the rename pencil): indented list of all collections + Unsorted.
  - Card "Stack…" control (may live in the same small menu as Move to…):
    set/clear stack_label, with existing labels in that collection offered as
    quick choices (datalist or buttons) plus free-text.
- **Manage sections modal** ("Edit shelves" affordance in the library header):
  create (title + optional parent picker), rename inline, reorder among
  siblings (↑/↓), delete (confirm dialog stating how many novels fall to
  Unsorted and how many eras promote to top-level). Existing modal patterns,
  both themes.
- Novel create/import: untouched — new novels land Unsorted.

## Tests (red-green)

- Endpoints: title validation; parent rules (nesting >1 level 400, parenting a
  collection that has children 400, promote via explicit null); 404s;
  delete-nulls-members-and-promotes-children; novel assignment (unknown
  collection 400, null clears, omitted no-ops; stack_label trim/null rules).
- Migration: legacy DB gains table + both novel columns (mirror the owner_id
  migration test).
- UI: house source-grep pattern — hierarchical render, both chevron levels,
  localStorage key, shelf baseline class, stack render + expand handler, DnD
  handlers, move-to + stack controls, manage modal.

## Sizing

One unit (L). The library page rework is the bulk; endpoints are small.

## Out of scope

- Era labels / timeline_order metadata and world-scoped characters (W.4 proper).
- Nesting beyond one level; per-owner namespaces; stacks spanning collections.
- Reassigning documents between novels.
- Auto-detection of stacks (the operator will seed initial stacks server-side
  from import-manifest data; the UI only needs to render and edit them).

---

# v2.1 Addendum — Per-Owner Shelf Spaces

**Written:** 2026-07-11, after real use: the archivist filtered to *Mine*,
had only Unsorted, and Edit Shelves offered no control over HER shelves —
only the writer's structure. Global collections fail the second user.

## Model change

Each collection belongs to a user: `collections.owner_id TEXT REFERENCES
users(id)` (guarded ALTER; **backfill all existing collections to the
writer who owns the imported corpus** — they are her universe's shelves).

- **Library rendering:** under an owner filter (*Mine* / a named owner),
  render only that owner's shelf tree + that owner's unsorted novels. Under
  *All*, render each owner's shelf trees in turn (owner's display name as a
  small kicker above their top-level shelves when more than one owner has
  shelves), then a combined Unsorted.
- **Edit shelves modal:** operates on one owner's shelf space at a time —
  the filtered owner when a filter is active; your own under *All*. An
  archivist gets an owner switcher inside the modal (writers only ever see
  their own). Creating a shelf assigns that owner.
- **Move to… / Stack…:** a novel may only be filed onto a shelf belonging
  to the novel's owner; the pickers list exactly those shelves.
- **API:** POST /api/collections gains owner semantics like imports
  (archivist may name an owner, writers get themselves — reuse
  resolveOwnerId); PUT/DELETE require... no permission enforcement exists
  app-wide yet, so no gating beyond requireUser (C.1 matrix later), but
  novel-assignment validation becomes: 400 unless collection.owner_id =
  novel.owner_id.
- **GET /api/collections** returns all (with owner_id); the client scopes.

## Out of scope
Shared/household shelves (a novel on two people's shelves), shelf-level
permissions, cross-owner filing by archivist (deliberately strict for now —
revisit with C.1).
