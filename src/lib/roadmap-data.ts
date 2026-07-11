/**
 * Roadmap tab data (/help). Single source of truth for what's shipped, up
 * next, planned, and someday/ideas — writer-facing wording, no internal
 * ticket codes. Rendered by src/routes/help/+page.svelte, grouped by status.
 *
 * `key` is a stable, unique, kebab-case identifier — NOT the title. It's
 * what roadmap hearts (see /api/roadmap/hearts) key against, so renaming a
 * title never orphans existing hearts, and it must never be reused for a
 * different item.
 */
export interface RoadmapItem {
	key: string;
	title: string;
	note?: string;
	status: 'shipped' | 'next' | 'planned' | 'someday';
	/** YYYY-MM. Required for status: 'shipped', unused otherwise. */
	shipped?: string;
}

export const ROADMAP_STATUSES = ['shipped', 'next', 'planned', 'someday'] as const;

export const ROADMAP: RoadmapItem[] = [
	// ─── Shipped (2026-07) ───────────────────────────────────────────
	{
		key: 'archive-import',
		title: 'Your whole archive, imported',
		note: '20 years of work: 66 novels with every alternate version preserved',
		status: 'shipped',
		shipped: '2026-07'
	},
	{
		key: 'version-stacks',
		title: 'Version stacks & universe shelves',
		note: 'Universes → eras, stacks of sibling drafts, per-person shelf spaces',
		status: 'shipped',
		shipped: '2026-07'
	},
	{
		key: 'compare-snapshots',
		title: 'Compare any snapshot',
		note: 'Word-level diff + restore',
		status: 'shipped',
		shipped: '2026-07'
	},
	{
		key: 'user-guide',
		title: 'User guide',
		status: 'shipped',
		shipped: '2026-07'
	},
	{
		key: 'phone-friendly-binder',
		title: 'Phone-friendly binder',
		note: 'Reorder/move on touch, smarter new-doc placement',
		status: 'shipped',
		shipped: '2026-07'
	},
	{
		key: 'durable-backups',
		title: 'Backups that never forget',
		note: 'Daily off-site + a monthly copy kept forever',
		status: 'shipped',
		shipped: '2026-07'
	},

	// ─── Up next ──────────────────────────────────────────────────────
	{
		key: 'account-ownership',
		title: 'Accounts that respect ownership',
		note: 'Only you can edit your novels; today everyone technically can',
		status: 'next'
	},
	{
		key: 'change-own-password',
		title: 'Change your own password',
		status: 'next'
	},
	{
		key: 'search-index-housekeeping',
		title: 'Search index housekeeping',
		note: 'Deleted novels can leave phantom search results — fix coming',
		status: 'next'
	},
	{
		key: 'sturdier-scrivener-import',
		title: 'Sturdier Scrivener import',
		note: 'Crash-proofing',
		status: 'next'
	},

	// ─── Planned ──────────────────────────────────────────────────────
	{
		key: 'spoiler-shield',
		title: 'Spoiler shield',
		note: 'Hide chosen works/chapters from other readers, e.g. your sister',
		status: 'planned'
	},
	{
		key: 'writing-stats',
		title: 'Writing stats',
		note: 'Gentle word-count history — no guilt mechanics',
		status: 'planned'
	},
	{
		key: 'epub-title-page-polish',
		title: 'EPUB title-page polish',
		status: 'planned'
	},

	// ─── Someday / ideas ───────────────────────────────────────────────
	{
		key: 'duplicate-finder',
		title: 'Duplicate finder',
		note: 'In-app report of near-identical chapters across drafts',
		status: 'someday'
	},
	{
		key: 'author-notes-margins',
		title: 'Author notes in the margins',
		status: 'someday'
	},
	{
		key: 'universe-codex',
		title: 'Universe codex',
		note: 'A lore bible that spans novels',
		status: 'someday'
	},
	{
		key: 'wiki-style-links',
		title: 'Wiki-style links between documents',
		status: 'someday'
	}
];
