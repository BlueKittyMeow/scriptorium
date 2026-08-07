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
   `db.ts` migrations: run `sudo /usr/local/bin/scriptorium-backup` first and
   confirm the new snapshot exists. Routine UI deploys can rely on the nightly.
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

## Shared-host rules (Factotum hosts the house's DNS)

Never restart or reconfigure pihole-FTL, cloudflared, jellyfin, or caddy for
any Scriptorium purpose. `scriptorium.service` is ours; nothing else is.
