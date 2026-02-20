# Scriptorium — Code Review for Gemini

## Instructions

You are reviewing a SvelteKit web application: a preservation-first novel writing tool with a TipTap rich text editor, SQLite backend, binder tree, and full-text search.

**Your task:** Thoroughly review the codebase for bugs, security issues, logic errors, performance concerns, and code quality problems. Record ALL findings in this file — do NOT modify any source code.

**Focus on the most recent changes:** dark mode / CSS custom properties / persistent preferences. But also review the full codebase for anything that was missed in the previous review round.

---

## Project Overview

- **Framework:** SvelteKit (Svelte 5 with runes: `$state`, `$derived`, `$effect`, `$props`)
- **Database:** SQLite via better-sqlite3 (WAL mode, FTS5 full-text search)
- **Editor:** TipTap (ProseMirror-based)
- **Content storage:** HTML files on disk (SQLite stores metadata only)
- **Styling:** CSS custom properties for theming (light + dark)
- **Preferences:** localStorage for theme and spellcheck

---

## Complete File Listing

### Source Files (`src/`)
| File | Purpose |
|------|---------|
| `app.html` | HTML shell with inline theme flash-prevention script |
| `app.d.ts` | TypeScript globals (App.Locals with db) |
| `hooks.server.ts` | Attaches SQLite db to every request via event.locals |
| `lib/index.ts` | Empty barrel file |
| `lib/types.ts` | Shared TypeScript interfaces (TreeNode, etc.) |
| `lib/components/Editor.svelte` | TipTap rich text editor with toolbar, search, spellcheck |
| `lib/server/db.ts` | SQLite setup, schema creation, singleton |
| `lib/server/files.ts` | Disk I/O helpers (atomic write, read, strip HTML) |
| `lib/server/tree-ops.ts` | Shared tree operations (cascade delete, FTS re-index, soft-delete) |
| `lib/server/import/scriv.ts` | Scrivener .scriv project importer |
| `routes/+layout.svelte` | Root layout with CSS custom properties, theme toggle |
| `routes/+page.svelte` | Library home page (novel grid, create, import, rename) |
| `routes/novels/[id]/+page.server.ts` | Server load: fetches novel + word count |
| `routes/novels/[id]/+page.svelte` | Novel workspace (sidebar binder + editor) |
| `routes/api/novels/+server.ts` | GET list, POST create novel |
| `routes/api/novels/[id]/+server.ts` | GET, PUT, DELETE novel |
| `routes/api/novels/[id]/tree/+server.ts` | GET full tree, PUT reorder/reparent |
| `routes/api/novels/[id]/tree/nodes/+server.ts` | POST create folder or document |
| `routes/api/novels/[id]/tree/nodes/[nodeId]/+server.ts` | DELETE (soft), PATCH (rename/restore) |
| `routes/api/documents/[id]/+server.ts` | GET content+metadata, PUT save |
| `routes/api/documents/[id]/snapshots/+server.ts` | GET list, POST manual snapshot |
| `routes/api/documents/[id]/snapshots/[snapId]/+server.ts` | GET snapshot content |
| `routes/api/search/+server.ts` | FTS5 full-text search |
| `routes/api/admin/import/+server.ts` | Import .scriv directory |

### Test Files (`tests/`)
| File | Purpose |
|------|---------|
| `helpers.ts` | Test utilities (in-memory DB, seed data) |
| `db.test.ts` | busy_timeout verification |
| `import.test.ts` | Import sort order + transaction safety |
| `tree-restore.test.ts` | FTS re-indexing on folder restore + novel soft-delete |
| `editor-save.test.ts` | Editor save reliability (keepalive, async switchDocument) |
| `theme-prefs.test.ts` | CSS variables, dark theme, flash prevention, spellcheck persistence |

---

## Areas of Focus

### 1. Dark Mode / Theming
- CSS custom property completeness — any missed hardcoded colors?
- Dark theme color choices — contrast, readability, accessibility
- Flash-prevention script correctness
- Theme toggle cycle logic
- `prefers-color-scheme` listener behavior

### 2. localStorage Usage
- Spellcheck persistence — SSR safety (typeof localStorage check)
- Theme persistence — sync between app.html script and layout component
- Edge cases: localStorage disabled, private browsing, quota exceeded

### 3. Security
- SQL injection vectors (parameterized queries?)
- Path traversal in file operations
- XSS in user content
- Input validation on API endpoints

### 4. Data Integrity
- Atomic write correctness
- FTS index consistency with document lifecycle
- Soft-delete / restore completeness
- Snapshot creation logic

### 5. Error Handling
- Uncaught promise rejections
- Missing error boundaries
- API endpoints returning appropriate status codes

### 6. Performance
- Unnecessary re-renders in Svelte 5
- Database query efficiency
- Large document handling

### 7. Accessibility
- Keyboard navigation
- ARIA attributes
- Screen reader compatibility
- Color contrast in both themes

### 8. Code Quality
- TypeScript strictness
- Dead code
- Naming consistency
- Missing type annotations

---

## Severity Scale

- Critical: Data loss, security vulnerability, crash
- High: Functional bug affecting user workflows
- Medium: Edge case bug, performance issue, or maintainability concern
- Low: Style, naming, minor improvement
- Note: Observation, not necessarily a bug

---

## Findings

### 🔵 Note: Flash Prevention Script
- **File:** `src/app.html`
- **Description:** The inline script correctly checks `localStorage` and `prefers-color-scheme` to set the `data-theme` attribute before the page content and SvelteKit runtime load, effectively preventing theme flashing.
- **Severity:** Note

### 🔵 Note: Reliable Autosave Mechanism
- **File:** `src/lib/components/Editor.svelte`
- **Description:** The application now uses `keepalive: true` for the final save in `onDestroy` and an async `switchDocument` function to await onsave when switching documents, addressing potential data loss during navigation.
- **Severity:** Note

### 🔵 Note: Improved Tree Operations
- **File:** `src/lib/server/tree-ops.ts`
- **Description:** Tree operations (soft-delete, restore, cascade delete) have been consolidated and improved to handle FTS re-indexing and metadata consistency (e.g., `updated_at`).
- **Severity:** Note

### 🟡 Minor: LocalStorage Quota Edge Case
- **File:** `src/lib/components/Editor.svelte`
- **Description:** `localStorage.setItem` for spellcheck and theme does not currently handle potential `QuotaExceededError`. While unlikely to be an issue for these small values, it's a known edge case for `localStorage`.
- **Suggested Fix:** Wrap `localStorage.setItem` calls in a `try/catch` block to handle potential errors gracefully.
- **Severity:** Minor

### 🟡 Minor: Theme Cycle UX
- **File:** `src/routes/+layout.svelte`
- **Description:** The theme cycling order (`system -> light -> dark`) is functional, but provide more visual feedback on the button state itself (currently just an icon) could improve usability.
- **Suggested Fix:** Consider adding a label or more distinct visual states for the theme toggle.
- **Severity:** Minor

### 🔵 Nit: CSS Variable Coverage
- **File:** `src/routes/+layout.svelte`
- **Description:** The transition to CSS variables is thorough across all components, eliminating almost all hardcoded hex values and simplifying theme maintenance.
- **Severity:** Nit


