# Phase 2 Implementation Plan
## Persistent Spellcheck + Dark Mode

### Overview

Two features that share a common dependency: a user preferences system.

**Current state:** Zero theming infrastructure. All ~30 color values are hardcoded hex strings scattered across 4 style blocks. No CSS custom properties. No `localStorage` usage. No `prefers-color-scheme` query. Spellcheck toggle resets on every navigation.

---

### Step 1: Extract CSS Custom Properties

Convert all hardcoded colors across 4 files into CSS custom properties on `:root` in `+layout.svelte`.

**Files to touch:**
- `src/routes/+layout.svelte` — define all `--var` tokens, global styles use them
- `src/routes/+page.svelte` — library page colors
- `src/routes/novels/[id]/+page.svelte` — workspace + sidebar colors
- `src/lib/components/Editor.svelte` — editor chrome + TipTap content styles

**Token naming convention:** `--color-{role}` (e.g., `--color-bg`, `--color-text`, `--color-accent`, `--color-border`)

**Light theme values** = current hardcoded values (visual result is identical after extraction).

---

### Step 2: Define Dark Theme

Add `[data-theme="dark"]` selector block in `+layout.svelte` that overrides all CSS custom properties with dark equivalents.

**Dark palette direction:** Warm dark (not cold gray). Think aged leather / dark wood rather than charcoal IDE. Consistent with the "Victorian scriptorium" aesthetic.

**Also add:**
```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark vars */ }
}
```
This respects OS preference when no explicit choice is stored.

---

### Step 3: localStorage Preferences

Simple key-value store in `localStorage`:
- `scriptorium-theme` → `'light'` | `'dark'` | `'system'` (default: `'system'`)
- `scriptorium-spellcheck` → `'true'` | `'false'` (default: `'true'`)

**Why localStorage, not DB?**
- No auth yet (server doesn't know who's asking)
- Preferences are per-device anyway (phone might want dark, desktop light)
- When multi-device sync arrives (Phase 3), preferences can optionally sync

**Initialization (flash prevention):**
Add a tiny inline `<script>` in `app.html` that reads `localStorage` and sets `data-theme` on `<html>` BEFORE the page renders. This prevents the light→dark flash on load.

---

### Step 4: Theme Toggle UI

Add a sun/moon toggle button in the global layout header (visible on every page). Three-state cycle: system → light → dark → system.

Small, unobtrusive — bottom-right corner or header bar.

---

### Step 5: Persistent Spellcheck

In `Editor.svelte`:
- On mount, read `localStorage` for spellcheck preference
- On toggle, write to `localStorage`
- Default remains `true` if no stored preference

---

### Implementation Order

1. CSS custom property extraction (mechanical, largest diff, zero behavior change)
2. Dark theme color definitions
3. `app.html` inline script for flash prevention
4. Theme toggle component in layout
5. Spellcheck localStorage persistence
6. Tests
7. Build verification

---

### Test Plan

- **CSS variables test:** Verify no hardcoded color hex values remain in style blocks (grep-based)
- **Theme toggle test:** Verify `data-theme` attribute changes on toggle
- **Spellcheck persistence test:** Verify `localStorage` key set/read in Editor source
- **Existing tests:** All 7 must continue passing
