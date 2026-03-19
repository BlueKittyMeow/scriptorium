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
- `data/{novelId}/docs/{docId}.html` -- document content
- `data/{novelId}/snapshots/{docId}/{timestamp}.html` -- version snapshots

SQLite database at `./scriptorium.db` (created automatically on first run).
