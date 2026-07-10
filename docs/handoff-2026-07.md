# Session Handoff — 2026-07-09

**For:** the next Claude Code session (or a human resuming cold). This is a public repo: server LAN details, credentials, and personal emails are deliberately absent — machine specifics live in the operator's private notes (`~/.claude/CLAUDE.md`, machines table) and session memory.

## Where things stand

**The MVP is live.** `https://scriptorium.bluekittymeow.com` — deployed from branch `mvp`, both accounts created (archivist "UponMidnight" = Lara, writer "Lunamaiye" = Kyla, sister). Nightly backups run at 4:00am with off-site sync to the archivist's Google Drive; a restore drill was performed and passed.

### Deployment facts (server: "Factotum", the home Pi)
- App checkout: `~/apps/scriptorium` (branch `mvp`), Node 22, pandoc installed (no LaTeX — PDF export deferred).
- Service: `scriptorium.service` — loopback port 8090, `DATA_ROOT=/mnt/media/scriptorium/data`, `ORIGIN=https://scriptorium.bluekittymeow.com`, `BODY_SIZE_LIMIT=10M`. Enabled for reboot.
- Exposure: cloudflared tunnel ingress (rule above the 404 catch-all; config backup `config.yml.bak.20260709-195916`).
- **Deploy an update:** `ssh` to Factotum → `cd ~/apps/scriptorium && git pull --ff-only && npm ci && npm run build && sudo systemctl restart scriptorium` → `curl -sI http://127.0.0.1:8090/` expects a 302.
- Backups: `/usr/local/bin/scriptorium-backup` (repo copy: `scripts/backup.sh`), `scriptorium-backup.timer` daily 04:00, `BACKUP_DIR=/mnt/media/scriptorium/backups`, rclone remote `uponmidnight-gdrive:Scriptorium Backups`.

### HARD OPERATIONAL RULES (learned this session)
1. **Never restart pihole-FTL or any shared Factotum service** (cloudflared, jellyfin, caddy) without Lara's explicit in-the-moment approval. Local device name resolution lives on the Pi-hole itself — a restart drops it for the whole house. Restarting `scriptorium.service` is fine (it's ours).
2. **Subagents for implementation** (opus = delicate, sonnet = well-specified); Fable/lead session writes specs, reviews every diff, runs `npm test` + `npm run check`, commits per logical unit, pushes. Commit-and-push after each unit is the house style.
3. **This repo is public** — never commit emails, tokens, LAN topology.

### Cleanup TODO (small but real)
- Lara added a temporary `/etc/hosts` entry on her workstation (`104.21.41.52 scriptorium.bluekittymeow.com`) because the **router** cached an NXDOMAIN from before the DNS record existed. Once normal resolution is confirmed (test after removing the line: `sudo sed -i '/scriptorium.bluekittymeow.com/d' /etc/hosts`), remove it — Cloudflare edge IPs can rotate and a stale pin would cause a confusing outage later.

## What shipped this session (all on `mvp`, all pushed)

| Commit | Unit |
|--------|------|
| `1112ab0`..`1e19a46` | Planning docs: remediation plan (15+ verified/spec'd defects), MVP plan, UX/stats/collab/universe roadmap |
| `ffc2a5a` | @types packages (P2-1 part) |
| `dd868cc` | **P0-1 doc-switch save corruption fix** + save-failure surfacing + phone pass (M.1/M.2/M.4) |
| `8acd758` | Scrivener import hardening (P1-9) + title-page stacking (P1-10) + pandoc stdin guard |
| `9903b91` | Trash/restore integrity (P0-2, P0-3, P1-1..P1-4) |
| `dc4027b` | API validation batch (P1-5/P1-6/P2-4/P2-5) + typecheck to zero |
| `57008f4` | Mobile layout polish (top-bar flow + workspace exemption, admin table scroll, 16px inputs) |
| `2ccfb5d` | Backup script (W6) |
| `bb7f5d0` | Ownership-lite: owner tagging + bookshelf toggle + archivist owner picker + library server-load perf fix |

Suite: **336 tests green; svelte-check 0 errors 0 warnings.** Deployed through `bb7f5d0`.

## Key documents (read before coding)
- `docs/remediation-plan-2026-07.md` — defect specs; **remaining unfixed:** P1-7/P1-8 (import FTS-folder pollution + transactionality), P2-6 (migrations scaffold — do before more schema work; ownership used an ad-hoc guarded ALTER in `db.ts`), P2-7, P2-9, P2-10, P2-11, P3-*.
- `docs/mvp-plan.md` — workstreams; **remaining:** W5 (import Kyla's .scriv pile — copy bundles under the server user's `$HOME`, then batch import from the UI; owner dropdown now exists to assign them to her), M4 (self-service password change — small, spec'd in W4), the phone acceptance re-run after the mobile fixes.
- `docs/ux-and-stats-ideas.md` — the roadmap (mobile, navigation, triage-at-scale, stats platform, ownership §C.1 full matrix, notes/universes). Ownership-lite shipped only the *tagging* slice: **no permission enforcement yet** — any user can still edit any novel. The C.1 access-level matrix is the natural next feature block.

## Sensible next moves (in order)
1. Re-run the phone pass with fresh screenshots (top-bar overlap, admin table pan, and input zoom should all be gone; the bookshelf toggle and owner picker are new).
2. W5: import Kyla's Scrivener projects, assigned to her shelf.
3. M4 password change (one subagent, small).
4. P2-6 migrations scaffold, then the C.1 permission matrix + C.2 spoiler shield (specs complete in the ideas doc).
5. Merge `mvp` → `main` after a few days' bake.

## Known quirks
- Library "AGES" slowness on cellular: fixed via server-load; if slowness persists it's tunnel/cell latency, not the double-fetch.
- Compile: docx/markdown verified by args-policy tests; epub title-page dedup wiring (assemble `includeTitlePage:false` for epub) is exported but **not yet wired** in the compile route — small follow-up.
- 14 npm audit advisories (informational, unreviewed).
- `test-data/` contains a real Scrivener 2 sample (Talamus) — useful fixture for import work.
