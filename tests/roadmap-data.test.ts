import { describe, it, expect } from 'vitest';
import { ROADMAP, ROADMAP_STATUSES } from '../src/lib/roadmap-data.js';

/**
 * Roadmap tab data (src/lib/roadmap-data.ts) — the single source of truth
 * rendered by the Roadmap tab on /help. Static, writer-facing, no ticket
 * codes. Covers: shape validity, allowed status vocabulary, shipped items
 * carrying a shipped date, and unique stable keys (roadmap hearts key off
 * `key`, so collisions would silently merge two items' heart counts).
 */
describe('roadmap-data: shape', () => {
	it('exports a non-empty array', () => {
		expect(Array.isArray(ROADMAP)).toBe(true);
		expect(ROADMAP.length).toBeGreaterThan(0);
	});

	it('every item has a non-empty title and a status from the allowed set', () => {
		for (const item of ROADMAP) {
			expect(typeof item.title).toBe('string');
			expect(item.title.trim().length).toBeGreaterThan(0);
			expect(ROADMAP_STATUSES).toContain(item.status);
		}
	});

	it('every shipped item has a shipped date in YYYY-MM form', () => {
		for (const item of ROADMAP.filter((i) => i.status === 'shipped')) {
			expect(item.shipped).toBeTruthy();
			expect(item.shipped).toMatch(/^\d{4}-\d{2}$/);
		}
	});

	it('non-shipped items do not need a shipped date (not asserting absence, just that shipped ones are the only required case)', () => {
		// No-op guard against accidentally requiring `shipped` universally —
		// the type marks it optional, and only 'shipped' status uses it.
		expect(ROADMAP.some((i) => i.status !== 'shipped')).toBe(true);
	});

	it('every item has a stable, unique, kebab-case key', () => {
		const keys = ROADMAP.map((i) => i.key);
		for (const key of keys) {
			expect(typeof key).toBe('string');
			expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
		}
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('covers all four statuses at least once (nothing renders empty by omission)', () => {
		for (const status of ROADMAP_STATUSES) {
			expect(ROADMAP.some((i) => i.status === status)).toBe(true);
		}
	});
});
