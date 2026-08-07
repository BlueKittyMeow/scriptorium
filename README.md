# Scriptorium

A preservation-first novel writing application. See [spec.md](spec.md) for full design.

## Quick Start

```bash
npm install
npm run dev
```

Server runs at **http://localhost:5173/**. On first visit you'll be redirected to `/setup` to create your admin account.

## Prerequisites

- **Node.js** 18+
- **Pandoc** (for compile/export to docx, epub, PDF) -- `sudo apt install pandoc` or [pandoc.org](https://pandoc.org/installing.html)
- **LaTeX** (for PDF export only) -- `sudo apt install texlive-latex-recommended` or similar

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm run preview` | Preview production build locally |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run check` | Svelte/TypeScript type checking |

## Data

All data lives in `./data/` (configurable via `DATA_ROOT` env var):
- `data/scriptorium.db` -- SQLite database (created automatically on first run)
- `data/{novelId}/docs/{docId}.html` -- document content
- `data/{novelId}/snapshots/{docId}/{snapshotId}.html` -- version snapshots

## Backups

The deployed instance runs `scripts/backup.sh` nightly (see [docs/operations.md](docs/operations.md) → "Backup layers"). It is **preservation-first and copy-only** (changed 2026-08-07): the local data mirror (`rsync -a`, no `--delete`) and the off-site step (`rclone copy`, not `sync`) never remove files, so an accidental or intended local deletion can never propagate to any backup. Consequences worth knowing:

- The mirror is a **cumulative union of every file that ever existed on disk**, not a point-in-time image — permanently purging a novel/document no longer removes it from backups.
- **Restore** pairs the authoritative dated DB copy (`db/scriptorium-<date>.db`) with the mirror; orphan files the DB no longer references are ignored. Never restore from the raw `scriptorium.db` inside `data-mirror/` — it is a non-quiesced bystander copy.
- Copy-only protects against **deletion**, not against **in-place corruption** (a still-present but truncated/garbled file); only the monthly tarball defends against that.
