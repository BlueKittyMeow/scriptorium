# Operations — Deploying with Active Users

**Written:** 2026-07-11, once the instance had two live writers.

## Deploy protocol

1. **Activity check first.** A restart mid-keystroke is the only real user-facing
   risk (the outage itself is ~3–5s; the editor surfaces save failures and
   retries). Before restarting, check for recent writing — run this **on the
   server, from the repo directory**:
   ```bash
   cd ~/apps/scriptorium && DB=/mnt/media/scriptorium/data/scriptorium.db \
     node scripts/activity-check.js        # optional arg: window in minutes (default 10)
   ```
   It prints `quiet — safe to restart` or `ACTIVE — wait` with the last write
   time, and **exits 1 when active**, so it can gate the deploy directly:
   `node scripts/activity-check.js && git pull --ff-only && …`. If active, wait
   a few minutes and re-check.

   **`datetime(updated_at)` is load-bearing** (why the script exists, and why it
   wraps both sides). We store ISO-8601 (`2026-07-25T04:33:21.893Z`); SQLite's
   `datetime('now')` returns `2026-07-25 22:22:58`. Comparing them as raw
   strings compares `'T'` against `' '`, and `'T'` sorts higher — so every
   document touched *today* reads as active. An earlier inline version of this
   check omitted the wrapper and reported 12 active writers when the last write
   was 18 hours old (caught 2026-07-25).

   **Why a file and not a `node -e` one-liner** (both found 2026-08-02, after
   three failed attempts to run the old snippet over SSH):
   - The SQL contains single quotes — `datetime('now','-10 minutes')` — which
     collide with the single quotes wrapping an `ssh host '…'` command. The
     inner quotes close the outer string and SQLite gets `near "minutes":
     syntax error`. Escaping through two shells is not worth re-deriving.
   - Node resolves `better-sqlite3` relative to the **script's** directory, not
     the cwd, so a copy dropped in `/tmp` fails `MODULE_NOT_FOUND` no matter
     what you `cd` to first. Run it from inside the repo.
2. **Backup before schema-touching deploys.** Any deploy whose diff touches
   `db.ts` migrations: run `sudo systemctl start scriptorium-backup.service`
   first and confirm the new snapshot exists. Routine UI deploys can rely on
   the nightly. **Never trigger a manual backup with bare `sudo
   /usr/local/bin/scriptorium-backup`** — that runs as *root* and leaves
   root-owned files in `backups/` (esp. `monthly/`) that the nightly service
   (`User=bluekitty`) then can't overwrite, silently breaking it (see the
   ownership gotcha under "Backup layers"). Always drive it through the unit
   (runs as `bluekitty`), or `sudo -u bluekitty /usr/local/bin/scriptorium-backup`.
3. **Standard sequence** (build fully completes before the restart):
   ```bash
   cd ~/apps/scriptorium && git pull --ff-only && npm ci && npm run build \
     && sudo systemctl restart scriptorium
   curl -sI http://127.0.0.1:8090/   # expect 302
   ```
   `npm ci` may be skipped when the lockfile is unchanged.
4. **Verify** — 302 locally and through the tunnel; `journalctl -u scriptorium
   -n 20` for a clean boot (migrations log nothing when idempotent-skipped).

## Documentation freshness (part of every feature commit)

- **Roadmap:** the in-app Roadmap tab renders `src/lib/roadmap-data.ts`
  directly. Shipping or re-scoping a feature updates that file **in the same
  commit** — move the item to `shipped` with its date, add what's newly next.
  A shape test enforces structure; keeping the content honest is on the
  committer (lead session reviews for it).
- **User guide:** `/help`'s Guide tab has honesty-check tests that grep guide
  claims against real UI source — if a feature changes its controls, those
  tests fail until the guide is updated. Extend that pattern when documenting
  new features.

## Verification gates (never bypass)

- `npm test` and `npm run check` must pass **by exit code** before any commit.
  Never judge the suite through a pipe (`npm test | grep …` reports the grep's
  exit status, not the suite's — this has bitten us).
- Migrations must be idempotent (guarded ALTERs / CREATE IF NOT EXISTS) — they
  run on every boot.

## Branch/PR hygiene (multi-workstream)

- `mvp` is the deployed branch. Parallel workstreams (e.g. external analysis
  suites) should branch off `mvp` and land via PR, so review + the test gate
  happen before anything reaches the deploy path.
- After the current bake period: merge `mvp` → `main` and tag releases;
  deploy from tags so "what's running" is always answerable.

## Backup layers (verified 2026-07-11)

1. Live: SQLite WAL on the Pi's NVMe + per-document snapshot files.
2. Nightly 04:00 (`scriptorium-backup.timer`, enabled): VACUUM'd db snapshot
   per day (written to a `.tmp` then atomically renamed) + full data-mirror to
   `/mnt/media/scriptorium/backups`, 14-day prune of the *dailies only*.
3. Off-site: rclone to Google Drive `Scriptorium Backups/` (db/ + data-mirror/
   + monthly/) — the mirror carries every document's HTML and every snapshot
   file, not just the database.
4. Monthly long-retention tier (added 2026-07-11): first run of each calendar
   month archives that day's DB snapshot + a tarball of the full data mirror
   to `monthly/` — never auto-pruned, locally or off-site. Thinning old months
   (e.g. to one per year, years from now) is deliberately a human decision.
5. A restore drill was performed and passed pre-launch (2026-07-09).

**Deletions never propagate (changed 2026-08-07).** Both the local mirror and
the off-site step are **copy-only, not mirror**: the rsync data-mirror runs
without `--delete`, and the off-site step is `rclone copy`, not `rclone sync`.
Reason: for a preservation-first writing app, an accidental local deletion (bad
script, bug, fat-fingered `rm`) must never be replayed onto the backups. The
old deleting-mirror setup meant a local delete nobody noticed for a day would
be gone from every tier except the monthly tarball — up to a month of writing
at risk. The trade is that the mirror and the remote accumulate stale files
(including pruned dailies, which now linger off-site); thinning them is a
deliberate human decision, matching sibling repo Arkive's copy-everywhere rule.
The 14-day prune is scoped strictly to the dated DB snapshots (`db/scriptorium-*.db`)
and never touches mirrored content.

What copy-only does and does not protect, and how to restore:

- **Restore is `db/scriptorium-<date>.db` + the mirror, in that priority.** The
  dated DB copy is authoritative about what "current" means; the mirror is a
  *cumulative union of every content/snapshot file that ever existed on disk*,
  not a point-in-time image. Orphaned files the restored DB no longer references
  are simply ignored. Note the raw `scriptorium.db` (+`-wal`/`-shm`) also present
  inside `data-mirror/` is a non-quiesced bystander copy — **never restore from
  it; use the dated `db/` copy.**
- **Purge no longer removes anything from backups.** The app hard-deletes files
  on disk when a novel/document is permanently purged (empty-trash paths in
  `tree-ops.ts` / the admin purge route); copy-only means those files persist in
  the mirror and on Drive forever. That is the intended preservation trade — keep
  it in mind if a multi-user privacy/erasure request ever needs true deletion
  (that becomes a deliberate manual op, by design).
- **Deletion is covered; in-place corruption is not.** "Never propagate" is about
  *deletions*. If a source file is truncated/zeroed but still present (bad disk,
  buggy write), `rsync -a` and `rclone copy` will still overwrite the good copy
  with the bad one. Only the monthly tarball (a frozen point-in-time snapshot)
  defends against silent corruption — another reason the monthly tier exists.
- **Off-site `db/` now grows without bound** and is the dominant off-site grower:
  the 14-day prune is local-only, so every daily DB copy accumulates on Drive
  forever (a few–tens of MB each → low-single-digit GB/year, climbing with the
  corpus, sharing the `uponmidnight-gdrive:` quota). Thin `db/` by hand
  periodically, or later add a *scoped* off-site age-prune limited to
  `db/scriptorium-*.db` (which preserves the copy-only guarantee for
  `data-mirror/` and `monthly/`). Left as a human decision for now.

**Ownership gotcha — root-owned files silently break the nightly (bit us
2026-08, fixed 2026-08-07).** The service runs `User=bluekitty`, and every dir
under `/mnt/media/scriptorium/backups/` must stay `bluekitty:bluekitty`. A
manual `sudo /usr/local/bin/scriptorium-backup` (running as *root*) once created
`backups/monthly/` and its files as `root:root`. It went unnoticed for weeks
because the monthly step is `if [ ! -f ]` — July's file already existed, so the
step was skipped and off-site still ran. On **Aug 1** the script tried to create
a *new* `monthly/scriptorium-2026-08.db`, hit `Permission denied`, and `set -e`
killed the run **before the off-site `rclone` step** — so off-site silently
stopped for ~6 days while the local dailies kept succeeding. Fix was
`sudo chown -R bluekitty:bluekitty /mnt/media/scriptorium/backups/monthly`.
Lesson: never run the backup as root (see deploy rule 2); if a run ever fails,
check `journalctl -u scriptorium-backup.service` — a non-zero exit means the
off-site tier didn't run even though the daily DB copy did.

## Shared-host rules (Factotum hosts the house's DNS)

Never restart or reconfigure pihole-FTL, cloudflared, jellyfin, or caddy for
any Scriptorium purpose. `scriptorium.service` is ours; nothing else is.

## Maintenance review — 2026-10-12

The closing August 7 session left two backup items open. The copy-only deployment
and ownership repair were completed then; the handoff's contradictory pending
deployment paragraph has been corrected.

- **Remote daily retention:** still a policy decision. Read-only inspection found
  88 daily database copies, about 2.92 GiB, with ample space in the off-site account.
  There is no immediate storage reason to delete copies. Retention
  is unchanged; any future pruning must be explicitly scoped to dated daily DBs,
  preserving `data-mirror/` and `monthly/`.
- **Backup integrity detection:** still a future feature. A checksum manifest
  needs an edit-aware policy so normal writing is not mistaken for corruption.
  Copy-only backups plus permanent monthly archives remain the current design.
- **Current health:** installed backup script matches the repository; the October
  12 nightly service completed successfully. Local daily DBs use about 515 MiB,
  monthly archives 264 MiB, and the cumulative content mirror 96 MiB.

The broader fleet-monitoring proposal in the operator's August 25 notes includes
backup failure notifications, disk-space alerts, update checks, and service
hardening. Those shared-host changes are separate from this Scriptorium patch.

## Error recovery

Client API requests announce network, authentication, permission, missing-item,
validation, oversized-request, rate-limit, and server/storage failures. They never
automatically repeat a mutation or redirect a writer away from unsaved text.
The chapter list and active editor are only replaced after successful reads;
missing text files for documents with recorded words produce an error, not a
blank editable chapter. Storage exceptions expose safe messages, not paths or SQL.

Editor saves are serialized. A failed flush blocks chapter changes and snapshot
operations; edits made during an in-flight save cannot be marked saved by the
older response. Retry save and Download a copy remain available, and navigation
warns/blocks while changes are unconfirmed. This preserves text in the current
tab; persistent browser draft recovery is still a separate roadmap item.

Validation: `npm test` covers session-cookie renewal, request failure messages,
missing content, and save ordering. `npm run test:browser` launches its own local
server on port 5189 with a temporary database and invented writing. It verifies
expired authentication, failed reads/saves, retry, download, navigation guards,
and mobile error controls. It never uses the production database. Set
`BROWSER_EXECUTABLE` to an installed Chromium/Chrome binary (default
`/usr/bin/google-chrome`). Screenshots and results are written to a temporary
directory reported by the runner.

## Offline copies, numbering, and PDF export (2026-10-12)

Downloaded works live in account-keyed IndexedDB records, with a public, empty
service-worker shell at `/offline`. Authenticated HTML and API responses never
enter the service-worker cache. Download completion is published only after all
chapters arrive. Browser eviction and user-cleared storage remain possible;
persistent-storage permission is requested, and exports/backups remain necessary.
Signing out removes the active account marker; syncing checks the server account
again. Copies are not encrypted against someone using the same browser profile.

Every local write waits for its IndexedDB transaction to commit. Generations stop
one tab from replacing another tab's newer draft. Server saves compare a SHA-256
content revision; stale saves return 409, while retries of identical content are
safe. Conflict recovery currently uses a downloaded draft and manual comparison;
there is no automatic merge. Offline editing covers existing downloaded chapter
text; tree changes, imports, snapshots, and exports require the server.

Numbering is opt-in per work, restarts independently inside each folder, and can
exclude individual documents or folders. Nested folders have their own setting.
Numbers are computed from visible binder order, including for compiled headings;
stored titles are unchanged. A compile selection retains binder numbers (gaps
are possible when a numbered chapter is excluded from compilation).

PDF rendering requires Python 3 + WeasyPrint (`apt-get install --no-install-recommends
weasyprint` on Factotum); Word/EPUB/Markdown still use Pandoc. The PDF helper
`scripts/render-pdf.py` denies network and file resource loads. It reads assembled
HTML on stdin and writes PDF bytes on stdout, preserving chapter page breaks.
`SCRIPTORIUM_PDF_PYTHON` optionally selects an isolated test interpreter. Run from
the repository root. The former `wkhtmltopdf` dependency was absent on Factotum.
Download object URLs remain valid for one minute to allow mobile consumption.

Validation: `npm test`, `npm run check`, `npm run test:browser`, and
`npm run test:offline` (requires the PDF renderer and Chrome). The last command
uses disposable accounts/data and a production build to test service-worker cold
starts, offline saving/reconnection, conflict protection, storage failures,
chapter movement/numbering, and a real mobile-sized PDF download.

The shared verified backup engine is maintained in sibling `learning-platform`
at `deploy/household-backup/`, installed as `/usr/local/lib/household-backup/`.
Its systemd units are the deployment source of truth; install the shared engine
before using this repository's backup wrapper. It publishes checked SQLite
snapshots, records content SHA-256 manifests, rejects changed immutable writing
snapshots and unexplained content changes, and retains replaced mirror bytes by
hash. History begins when the manifests are first installed; it cannot identify
pre-existing corruption without an older trusted baseline. Remote daily backups,
monthly copies, mirrored writing, and content history are retained without
pruning. Local dated daily snapshots retain the established 14-day policy.

Restore drill, 2026-10-12: the current Drive snapshot matched the local database
(1,988 document rows); all 2,646 mirrored HTML files matched by SHA-256. The
restored app opened existing writing and created/read a new test chapter on an
isolated database. **When restoring the legacy data-mirror, exclude
`scriptorium.db*`; use the verified `db/` snapshot instead.** Old mirrors may
contain live SQLite WAL/SHM files from the former rsync implementation. Move any
such files aside before installing the chosen snapshot. Never open a restored
snapshot beside journals from a different database. Evidence is retained at
`/mnt/media/household-backup/restore-20261012/` on Factotum.
