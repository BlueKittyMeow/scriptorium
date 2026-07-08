# Scriptorium MVP Plan — Two-Person Deployment

**Date:** 2026-07-08
**Branch:** `mvp`
**Goal:** A live, internet-reachable Scriptorium where one writer can sign in from any device and just write — with her work durably stored, snapshotted, and backed up. One archivist (the admin) manages accounts, trash, and backups.

**People:** Lara = archivist/admin; Kyla = writer. Account emails and Google Drive identities are deliberately **not** committed to this public repo — they live in server config and in the operators' hands. Where this plan says "the archivist's Google Drive," substitute the real account at deploy time.

**Companion document:** [remediation-plan-2026-07.md](remediation-plan-2026-07.md) — referenced throughout as *RP*. This plan sequences a subset of RP items as MVP blockers; the rest follow after launch.

---

## What already exists vs. what MVP adds

Already built and working: editor with autosave + snapshots, binder tree, search, .scriv import (single + batch), compile/export, auth with writer/archivist roles, admin panel (users, trash, storage, audit), compare/merge, responsive layout, dark/light themes.

MVP adds nothing new to the app's feature surface except two small items (M4, M5). The work is: **fix the correctness bugs that matter for a real writer, deploy to always-on hardware behind HTTPS, create the two accounts, and stand up backups.** Sync/offline (spec Phase 3) stays out of scope — MVP is online-only.

## Non-goals (explicitly deferred)

- Offline editing / service worker / sync queue (spec Phase 3)
- Per-user Google Drive OAuth backup (spec Phase 3) — MVP uses an admin-owned server-side backup instead
- Characters/worlds/tags (Phase 4), corkboard/focus mode (Phase 5)
- PDF export on the server (needs LaTeX/wkhtmltopdf on ARM; docx/epub/markdown cover the real need — revisit later)
- More than two users, self-service registration

---

## Workstream 1 — Correctness fixes that block launch

These are the RP items a writer would actually hit. Do them on this branch, in this order, each with the regression test specified in RP. **W1-1 is the launch gate; nothing ships before it.**

| # | RP item | Why it blocks MVP |
|---|---------|-------------------|
| W1-1 | **P0-1** doc-switch save corruption + **P2-2** surface save failures | Kyla switching documents with unsaved edits corrupts the target doc. And writing over the internet means saves *will* fail sometimes (dead WiFi, sleep/wake) — the UI currently shows "Saved" even when the PUT failed. Both edits touch the same two functions; do together. |
| W1-2 | **P0-2** novel purge crash, **P0-3** user-delete FK failure | Admin features Lara will use in week one. |
| W1-3 | **P1-1 … P1-4** trash/restore integrity | Kyla will trash and restore things immediately. Restoring a novel must not produce an empty binder; restored items must not vanish. |
| W1-4 | **P1-5, P1-6, P2-4, P2-5** input validation | Cheap hardening before the API faces the internet. |

Also in this workstream:
- **P2-1**: `npm i -D @types/node @types/better-sqlite3` so `npm run check` passes — then the launch bar is `check` + `test` both green.
- **README fix:** README says the SQLite DB is at `./scriptorium.db`; [db.ts](../src/lib/server/db.ts) actually creates it at `{DATA_ROOT}/scriptorium.db` (default `./data/scriptorium.db`). Correct the README — it matters once DATA_ROOT is set in production.

RP items **not** gating MVP (do after launch, on this same branch): P1-7/P1-8 (import robustness), P2-6..P2-11, all P3.

## Workstream 2 — Production build & service (Factotum)

Target: the always-on Raspberry Pi 5 home server ("Factotum", DietPi/aarch64, NVMe at `/mnt/media`). The app is a single Node process with SQLite — a Pi 5 is ample for two users.

1. **Install runtime:** Node 20 LTS (arm64) via NodeSource or `apt`; `pandoc` via apt (skip LaTeX — see non-goals); build essentials only if `better-sqlite3` lacks an arm64 prebuilt (it usually ships one).
2. **App checkout:** clone the repo to `/opt/scriptorium` (or `~/apps/scriptorium`), `npm ci && npm run build` (adapter-node → `build/`).
3. **Data location:** `DATA_ROOT=/mnt/media/scriptorium/data` — on the NVMe, *not* the SD card. Create it owned by the service user. The SQLite DB lands inside it automatically.
4. **systemd unit** (`/etc/systemd/system/scriptorium.service`):
   ```ini
   [Unit]
   Description=Scriptorium writing app
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=bluekitty
   WorkingDirectory=/opt/scriptorium
   Environment=NODE_ENV=production
   Environment=PORT=8090
   Environment=HOST=127.0.0.1
   Environment=DATA_ROOT=/mnt/media/scriptorium/data
   Environment=ORIGIN=https://<chosen-hostname>
   ExecStart=/usr/bin/node build
   Restart=on-failure
   RestartSec=3

   [Install]
   WantedBy=multi-user.target
   ```
   Notes: bind to loopback only (the tunnel connects locally); `ORIGIN` is required by adapter-node for correct origin checking behind a proxy. **Port 8090 is a suggestion — check it's free first** (`ss -tlnp`); 8081/8085/8096/8444/53317 are taken on this host.
5. **Deploy script** (`scripts/deploy.sh`, run on the server): `git pull && npm ci && npm run build && sudo systemctl restart scriptorium`. Keep it dumb.

## Workstream 3 — HTTPS exposure (Cloudflare Tunnel)

Factotum already runs `cloudflared` fronting `*.bluekittymeow.com` services. Scriptorium is a dynamic app, so it follows the Jellyfin pattern (tunnel → app port directly, no Caddy in between):

1. Back up `/etc/cloudflared/config.yml` (timestamped copy — established house rule).
2. Add an ingress rule **above the catch-all 404**:
   ```yaml
   - hostname: <chosen-hostname>          # e.g. a subdomain of the existing zone
     service: http://127.0.0.1:8090
   ```
3. Validate (`cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate`), create the DNS route (`cloudflared tunnel route dns <tunnel> <hostname>`), restart cloudflared.
4. **Smoke test:** `curl -sSI https://<hostname>/` → expect a 302 to `/login` (or `/setup` pre-first-run).

Security posture at launch: TLS terminates at Cloudflare; app auth (bcrypt + hashed session tokens + rate limiting) is the access control; cookies get `Secure` automatically (host isn't localhost) and `SameSite=Lax` covers CSRF. Add RP **P3-6** (explicit Origin check) as a fast-follow, not a gate.

## Workstream 4 — Accounts & onboarding

1. First visit to the production URL → `/setup` → create the **archivist** account (Lara). Do this immediately after the tunnel goes live, before sharing the URL — setup is unauthenticated by design and must not be left open.
2. Archivist creates the **writer** account (Kyla) in Admin → Users with a strong generated password, delivered out-of-band (not email/SMS in plaintext ideally; a password manager share or in person).
3. **M4 (small feature, pre-launch):** self-service password change. Currently only an archivist can set passwords via the admin PATCH. Add `POST /api/auth/change-password` — requires current password, applies the same ≥8 rule, re-uses `hashPassword`, destroys the user's *other* sessions (keep the current one), writes an audit entry — plus a minimal form (settings popover from the top bar, or a `/account` page). Test: wrong current password → 403; success → old sessions invalid.
4. **M5 (small feature, pre-launch):** a `beforeunload` guard in the workspace when `saveStatus !== 'saved'`, so closing a tab mid-thought over a flaky connection warns first. (The `keepalive` PUT on destroy already exists; this is the belt to that suspender.)
5. Onboarding content for Kyla: one short page (`docs/writer-guide.md`, linked from the login page or just sent to her) — how to create a novel, the binder, snapshots ("the app quietly keeps history; ask Lara if you ever need Tuesday's version"), search (Ctrl+K), compile/export.

## Workstream 5 — Import Kyla's existing writing

If she has Scrivener projects: copy the `.scriv` bundles to the server under the service user's home directory (the import boundary requires `$HOME`) — e.g. `~/scriv-inbox/` via LocalSend/scp — then run **batch import** from the library UI, review the per-project report, and spot-check chapter counts against Scrivener. Delete the inbox copies after verification. If she has loose docs instead (.docx etc.), defer converter work: create novels manually and paste; note demand for a docx importer as a post-MVP item.

## Workstream 6 — Backups (admin-owned, interim)

Per-user Drive backup is Phase 3; MVP ships a server-side backup owned by the archivist. This is RP **P3-4** made concrete:

1. `scripts/backup.sh` on Factotum (committed to repo, paths via env):
   - `sqlite3 "$DATA_ROOT/scriptorium.db" "VACUUM INTO '$BACKUP_DIR/scriptorium-$(date +%F).db'"` — safe under WAL, no downtime.
   - `rsync -a --delete "$DATA_ROOT/" "$BACKUP_DIR/data-mirror/"` (content + snapshot HTML).
   - Prune: keep 14 daily DB copies.
2. Off-site: `rclone sync "$BACKUP_DIR" <archivist-gdrive-remote>:"Scriptorium Backups"` — rclone remote for the archivist's Google Drive configured **on Factotum** at deploy time (copy the existing remote config from the workstation or re-auth; the remote name/account stays out of the repo).
3. Schedule: daily cron/systemd-timer, e.g. 04:00. Log to a file; failure = non-zero exit + a line Lara can check.
4. **Restore drill is part of the definition of done:** on the workstation, pull yesterday's backup, point a dev server's `DATA_ROOT` at it, confirm a novel opens with content and snapshots intact. A backup that's never been restored is a hope, not a backup.
5. Backup dir lives on the NVMe (`/mnt/media/scriptorium/backups`) — never `/tmp` (4 GB tmpfs, house rule).

## Workstream 7 — Phone-ready pass

The writer's primary device is a phone, which promotes three items from [ux-and-stats-ideas.md](ux-and-stats-ideas.md) Tier M to launch-gating (full specs there):

- **M.1** — collapsing the sidebar on mobile strands the user (the only toggle slides off-screen with it). Verified in code; must fix.
- **M.2** — add/trash (and any future rename) actions are hover-revealed, so unreachable on touch. Nothing load-bearing behind hover at `pointer: coarse`.
- **M.4** — `100vh` → `100dvh` + viewport meta so the on-screen keyboard doesn't swallow the toolbar/footer.

Drag-and-drop reorder remains desktop-only at launch (documented limitation; the Move… dialog is a fast-follow, Tier M.3).

## Launch checklist (acceptance)

- [ ] `npm run check` and `npm test` green on `mvp` branch
- [ ] W1-1 verified manually: edit doc A, click doc B within 2 s → both docs correct on disk
- [ ] Kill the network mid-edit → editor shows unsaved/error state, not "Saved"; reconnect → save succeeds
- [ ] Service survives `sudo reboot` on Factotum (systemd enabled, DB on NVMe)
- [ ] HTTPS URL reachable from a phone off-WiFi (cellular)
- [ ] Archivist + writer accounts exist; setup page now returns 403-equivalent (redirects to login)
- [ ] Writer can: log in, create novel, write, see snapshots, search, export docx — from her own laptop
- [ ] **Phone pass** (real device, iOS Safari and/or Android Chrome): log in → open novel → collapse *and reopen* binder → create doc → write a paragraph with the keyboard up (toolbar/footer visible) → trash and restore a doc via touch
- [ ] Writer can change her own password (M4)
- [ ] Nightly backup ran at least once; restore drill performed
- [ ] Kyla's existing projects imported and spot-checked (if applicable)

## Suggested sequence

1. **W1** fixes with tests (the bulk of the coding) → merge-worthy on their own; merge `mvp` → `main` at the end regardless.
2. **W7** phone-ready pass (M.1/M.2/M.4) — before deployment so the phone acceptance test can pass.
3. **W2 + W3** in one sitting (server install → service → tunnel → smoke test).
4. **W4** accounts + M4/M5.
5. **W6** backups + restore drill.
6. **W5** import, then hand the writer the URL.

Post-launch fast-follows, in order: RP P1-7/P1-8, P3-6 (origin check), P2-6 (migrations scaffold — unblocks the rest), P3-1/P3-2 (snapshot thinning/dedup), P3-3 (reindex button).
