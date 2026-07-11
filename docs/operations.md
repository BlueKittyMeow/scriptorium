# Operations — Deploying with Active Users

**Written:** 2026-07-11, once the instance had two live writers.

## Deploy protocol

1. **Activity check first.** A restart mid-keystroke is the only real user-facing
   risk (the outage itself is ~3–5s; the editor surfaces save failures and
   retries). Before restarting, check for recent writing:
   ```bash
   node -e "const D=require('better-sqlite3');const db=new D(process.env.DB,{readonly:true});
     const r=db.prepare(\"SELECT COUNT(*) c FROM documents WHERE updated_at > datetime('now','-10 minutes')\").get();
     console.log(r.c ? 'ACTIVE — wait' : 'quiet — safe to restart')"
   ```
   (run on the server with DB pointed at the prod file). If active, wait a few
   minutes and re-check.
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
   per day + full data-mirror to `/mnt/media/scriptorium/backups`, 14-day prune.
3. Off-site: rclone to Google Drive `Scriptorium Backups/` (db/ + data-mirror/
   + monthly/) — the mirror carries every document's HTML and every snapshot
   file, not just the database.
4. Monthly long-retention tier (added 2026-07-11): first run of each calendar
   month archives that day's DB snapshot + a tarball of the full data mirror
   to `monthly/` — never auto-pruned, locally or off-site. Thinning old months
   (e.g. to one per year, years from now) is deliberately a human decision.
4. A restore drill was performed and passed pre-launch (2026-07-09).

## Shared-host rules (Factotum hosts the house's DNS)

Never restart or reconfigure pihole-FTL, cloudflared, jellyfin, or caddy for
any Scriptorium purpose. `scriptorium.service` is ours; nothing else is.
