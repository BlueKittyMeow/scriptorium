# W5b — Bulk Standalone Import & In-App Version Triage (Spec)

**Status:** spec complete, implementation not started
**Depends on:** nothing in-app (compare/merge and .scriv batch import already shipped)
**Written:** 2026-07-10

## Goal

Get the non-Scrivener remainder of a legacy writing corpus (standalone manuscripts,
poetry/song collections, serialized excerpts) into Scriptorium as structured novels,
with non-identical version variants preserved and reviewable side-by-side in-app so
the author — not the importer — picks the canonical text.

Context: an offline pipeline (operator's workstation, outside this repo) has already
crawled, hashed, text-extracted, and deduplicated the corpus. Word-for-word identical
copies collapse automatically; every *near*-match survives as a variant that needs a
human decision. The app's job is (a) ingest the curated structure, (b) make the
variant decision pleasant.

## Existing pieces this builds on

| Piece | Where | Reused for |
|-------|-------|-----------|
| .scriv batch import + owner assignment | `src/routes/api/import/batch/+server.ts` | endpoint shape, `$HOME` containment guard, `resolveOwnerId` |
| Path resolution guards | `src/lib/server/import/resolve-path.ts` | bundle path validation |
| Word-level diff | `src/lib/server/compare/diff.ts` (`computePairDiff`, jsdiff) | snapshot diff endpoint |
| Diff rendering | `src/lib/components/DiffView.svelte` | snapshot diff UI |
| Snapshots (content on disk, `reason` column, restore endpoint) | `src/lib/server/db.ts`, `api/documents/[id]/{snapshots,restore}` | variant storage — **no schema change needed** |

## Design decisions

1. **The server ingests HTML only.** Legacy-format conversion (rtf/doc/odt/pages/pdf)
   happens offline in the pipeline (LibreOffice), which emits per-document HTML. The
   app gains zero converter dependencies, and conversion quality is controlled where
   it can be inspected. (Pandoc-on-server was rejected: pandoc cannot read `.doc` at
   all, and rtf support is weak.)
2. **Variants ride on snapshots.** A document's non-canonical near-versions import as
   snapshots of the canonical document, with `reason = 'imported-variant: <source
   filename>'` and `created_at` = the source file's mtime. Preservation-first: nothing
   is dropped, the timeline is honest, restore already works. Genuinely divergent
   versions (pipeline marks these — e.g. an alternate draft that reads differently
   throughout) become sibling documents instead, at the pipeline's discretion.
3. **The triage surface is a snapshot diff view.** One new read-only endpoint plus
   wiring `DiffView` into `SnapshotPanel`. Generally useful beyond import: "what
   changed since this snapshot" has value for everyday writing too.

## Unit A — Import bundle format (pipeline-side; no app code)

A bundle is a directory:

```
bundle/
  bundle.json
  content/<work-key>/<doc-key>.html
  content/<work-key>/<doc-key>.variant-<n>.html
```

`bundle.json`:

```jsonc
{
  "version": 1,
  "works": [
    {
      "key": "stable-unique-key",            // pipeline manifest id; idempotency handle
      "title": "Novel title",
      "folders": [ { "key": "f1", "title": "Part One", "parent": null } ],
      "documents": [
        {
          "key": "d42",
          "title": "Chapter title",
          "folder": "f1",                     // or null for root
          "order": 3,                         // sort within parent
          "html": "content/work-key/d42.html",
          "source_note": "Desktop/Writing/… (2014-05-20)",  // provenance, goes in synopsis
          "variants": [
            {
              "html": "content/work-key/d42.variant-1.html",
              "label": "TigrenacheMay20.doc",
              "timestamp": "2014-05-20T00:00:00Z"
            }
          ]
        }
      ]
    }
  ]
}
```

Rules: keys unique within the bundle; every referenced html file must exist inside
the bundle dir; timestamps ISO-8601; variant lists ordered oldest→newest.

## Unit B — `POST /api/import/bundle`

Body: `{ path, owner_id?, dry_run? }`.

- Auth: `requireUser`; owner assignment via the existing archivist-only
  `resolveOwnerId` logic (extract it from `batch/+server.ts` into a shared helper
  rather than copying).
- Path validation: same realpath + `$HOME` containment guard as batch import; then
  verify every `html` path in `bundle.json` resolves *inside* the bundle dir (reject
  `../` escapes).
- Validation of `bundle.json` follows the API-validation conventions established in
  the P1-5/P1-6 batch (explicit field checks, 400 with message; keep the style
  consistent with the other endpoints rather than introducing a new library).
- Import semantics, per work, inside one transaction:
  1. Skip (report `skipped: already imported`) if a novel already exists whose
     `import_source` matches the work key — see Idempotency below.
  2. Create novel (owner from `resolveOwnerId`), folders (two-level max in v1,
     matching what the binder supports well), documents in `order`.
  3. Document content: sanitize through the same path scriv import uses (whatever
     normalization it applies — implementer: match `importScriv`'s handling exactly;
     if scriv import relies on TipTap-side normalization on first open, do the same,
     but confirm and note it in the PR).
  4. Write content files to `data/{novelId}/docs/{docId}.html`, FTS index, word
     counts — same as scriv import.
  5. Variants: write snapshot content files, insert `snapshots` rows with
     `reason = 'imported-variant: ' + label`, `created_at = timestamp`, update
     `last_snapshot_at`.
- **Idempotency:** novels gain a nullable `import_source TEXT` column (guarded ALTER
  in `db.ts`, same pattern as `owner_id`; if the P2-6 migrations scaffold lands
  first, use it instead). Batch .scriv import should start populating it too
  (`scriv:<basename>` — cheap, one line) so re-imports become detectable there as
  well.
- `dry_run: true` → validate everything, return the per-work report (docs/folders/
  variants counts, skip status) without writing.
- Response: array of `ImportReport`-shaped results (add `variants_imported` and
  `skipped` fields to the type).

## Unit C — Snapshot diff view

- `GET /api/documents/[id]/snapshots/[snapId]/diff` → load snapshot HTML + current
  doc HTML, strip both to plaintext (reuse the compare feature's HTML→text step from
  `src/lib/server/compare/collect.ts`), return `computePairDiff` output plus both
  word counts and the snapshot's `reason`/`created_at`.
  - Auth + same-document ownership checks consistent with the existing snapshot
    content endpoint; 404 for soft-deleted docs, matching existing behavior.
- `SnapshotPanel.svelte`: each entry gets a **Compare** action → shows `DiffView`
  (modal or panel-takeover, implementer's choice — match existing panel aesthetics)
  with the existing Restore button available from within the view. Show `reason` as
  the entry label; `imported-variant:` reasons display the source filename.

## Unit D — Import UI wiring (small)

The existing import page gains a "bundle path" input beside the .scriv scan flow
(archivist sees the owner picker, as with batch import). Dry-run first, show the
report, then a confirm button runs the real import.

## Testing (red-green, per house style)

- Bundle validation: missing/duplicate keys, html path escaping the bundle dir,
  bad timestamps, empty works — each 400s with a useful message.
- Import: fixture bundle in `test-data/` (tiny: 1 work, 2 docs, 1 variant) →
  correct novel/folder/doc/snapshot rows, FTS searchable, snapshot `created_at`
  honors the variant timestamp (not "now"), `import_source` set, re-import skips.
- Dry run: no rows written.
- Diff endpoint: identical content → zero changes; a known edit → expected
  added/removed spans; 404s for foreign snapshot ids.
- Existing suite stays green (336 at time of writing).

## Sizing & delegation

| Unit | Size | Agent |
|------|------|-------|
| A (pipeline emits bundle) | M | sonnet, offline pipeline side — no app code |
| B (bundle endpoint) | L | opus — transactional import, validation surface |
| C (snapshot diff) | M | sonnet — reuses computePairDiff + DiffView |
| D (UI wiring) | S | sonnet |

C is independently shippable and useful; do it first. B waits for A's format freeze
(this spec is the freeze unless implementation finds a reason to amend). Commit per
unit; lead session reviews every diff and runs `npm test` + `npm run check`.

## Out of scope

- Permission enforcement (C.1 matrix) — unchanged by this work.
- Text-less PDFs (scans, cover art): the pipeline excludes them; the bundle format
  has no binary-asset support in v1.
- Arbitrary doc-vs-doc compare within a novel (compare stays novel-vs-novel; the
  snapshot diff covers the variant case).
- Import rollback UI (soft-delete of a mis-imported novel already covers it).
