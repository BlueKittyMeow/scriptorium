import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * /help tabs: Guide | Roadmap | Requests & Questions. Source-grep tests
 * (structural, same idiom as help-guide.test.ts) covering:
 * 1. The tab nav exists with all three tabs.
 * 2. An anchor into the guide (#snapshots etc.) resolves to the Guide tab —
 *    the actual mechanism (checking location.hash before ?tab=) is pinned.
 * 3. The Roadmap tab groups items under friendly headings with status chips,
 *    and renders a heart toggle on non-shipped items only.
 * 4. The Requests & Questions tab has a submit form, an empty-state message,
 *    archivist-only status/response controls, and a reply affordance gated
 *    to question-type items for non-archivists.
 */

const HELP_PATH = 'src/routes/help/+page.svelte';
const source = () => fs.readFileSync(HELP_PATH, 'utf-8');

describe('help tabs: nav', () => {
	it('has a tab nav with Guide, Roadmap, and Requests & Questions', () => {
		const src = source();
		expect(src).toMatch(/<nav class="tabs"/);
		expect(src).toMatch(/>Guide</);
		expect(src).toMatch(/>Roadmap</);
		expect(src).toMatch(/Requests\s*&amp;\s*Questions|Requests & Questions/);
	});

	it('styles tabs with CSS variables only (both themes)', () => {
		const src = source();
		const styleBlock = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
		const tabsRules = styleBlock.match(/\.tabs[^{]*\{[^}]*\}/g) || [];
		expect(tabsRules.length).toBeGreaterThan(0);
		for (const rule of tabsRules) {
			const hexColors = rule.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
			expect(hexColors).toHaveLength(0);
		}
	});
});

describe('help tabs: anchor handling', () => {
	it('resolves a url hash into the Guide tab before honoring ?tab=', () => {
		const src = source();
		// Whatever the exact function shape, the source must check the current
		// URL's hash and resolve to 'guide' before it looks at the ?tab= query
		// param (page.url.hash — SvelteKit's universal current-URL accessor,
		// works during SSR and CSR alike; plain `location` is client-only).
		const hashIdx = src.indexOf('.hash');
		const tabParamIdx = src.indexOf(".get('tab')") !== -1 ? src.indexOf(".get('tab')") : src.indexOf('.get("tab")');
		expect(hashIdx).toBeGreaterThan(-1);
		expect(tabParamIdx).toBeGreaterThan(-1);
		expect(hashIdx).toBeLessThan(tabParamIdx);
	});

	it('the guide sections remain in the markup unconditionally (anchors always resolvable)', () => {
		const src = source();
		for (const id of ['library', 'snapshots', 'tips', 'archivists']) {
			expect(src).toContain(`<section id="${id}"`);
		}
	});
});

describe('help tabs: roadmap', () => {
	it('imports the shared ROADMAP data (single source of truth)', () => {
		const src = source();
		expect(src).toMatch(/from ['"]\$lib\/roadmap-data(\.js)?['"]/);
		expect(src).toContain('ROADMAP');
	});

	it('groups items under friendly headings', () => {
		const src = source();
		expect(src).toContain('Recently shipped');
		expect(src).toContain('Up next');
		expect(src).toContain('Planned');
		expect(src).toMatch(/Someday/);
	});

	it('renders a status-colored chip per item using CSS variables only', () => {
		const src = source();
		expect(src).toMatch(/roadmap-chip/);
		const styleBlock = src.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
		const chipRules = styleBlock.match(/\.roadmap-chip[^{]*\{[^}]*\}/g) || [];
		expect(chipRules.length).toBeGreaterThan(0);
		for (const rule of chipRules) {
			const hexColors = rule.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
			expect(hexColors).toHaveLength(0);
		}
	});

	it('offers a heart toggle control', () => {
		const src = source();
		expect(src).toMatch(/heart-btn/);
		expect(src).toMatch(/[♡♥]/);
		expect(src).toContain('toggleHeart');
	});

	it('excludes the heart control from shipped items', () => {
		const src = source();
		// The heart button must be gated behind a non-shipped check, somewhere
		// near the heart-btn usage.
		const heartBtnIdx = src.indexOf('heart-btn');
		expect(heartBtnIdx).toBeGreaterThan(-1);
		const nearby = src.slice(Math.max(0, heartBtnIdx - 400), heartBtnIdx);
		expect(nearby).toMatch(/status !== 'shipped'/);
	});
});

describe('help tabs: requests & questions', () => {
	it('has a submit form with type select, title input, and optional body', () => {
		const src = source();
		expect(src).toMatch(/class="feedback-form"/);
		expect(src).toMatch(/<select[^>]*bind:value={newType}/);
		expect(src).toMatch(/<input[^>]*bind:value={newTitle}/);
		expect(src).toMatch(/<textarea[^>]*bind:value={newBody}/);
	});

	it('has a warm empty-state message', () => {
		const src = source();
		expect(src).toMatch(/Nothing here yet/);
	});

	it('shows each item with type badge, title, body, author/date, and status chip', () => {
		const src = source();
		expect(src).toMatch(/type-badge/);
		expect(src).toMatch(/status-chip/);
		expect(src).toMatch(/author_username/);
	});

	it('renders a response as a quoted reply when present', () => {
		const src = source();
		expect(src).toMatch(/<blockquote[^>]*class="feedback-response"/);
	});

	it('gates the status select + response textarea to archivists only', () => {
		const src = source();
		const gateIdx = src.indexOf('{#if isArchivist}');
		expect(gateIdx).toBeGreaterThan(-1);
		const archivistBlock = src.slice(gateIdx, gateIdx + 800);
		expect(archivistBlock).toMatch(/status-select/);
		expect(archivistBlock).toMatch(/<textarea/);
	});

	it('gates the Reply affordance to question-type items for non-archivists', () => {
		const src = source();
		// The reply button must live inside a branch that checks item.type === 'question'
		const replyIdx = src.indexOf('reply-btn');
		expect(replyIdx).toBeGreaterThan(-1);
		const nearby = src.slice(Math.max(0, replyIdx - 600), replyIdx);
		expect(nearby).toMatch(/item\.type === 'question'/);
	});
});

describe('help tabs: fetch usage is scoped to the DB-backed tab, not the static guide', () => {
	it('fetch( only targets /api/feedback or /api/roadmap/hearts', () => {
		const src = source();
		const fetchCalls = [...src.matchAll(/fetch\((['"`])([^'"`]*)\1/g)].map((m) => m[2]);
		expect(fetchCalls.length).toBeGreaterThan(0);
		for (const url of fetchCalls) {
			expect(url.startsWith('/api/feedback') || url.startsWith('/api/roadmap/hearts')).toBe(true);
		}
	});
});

describe('help tabs: guide cross-link', () => {
	it('the Tips section points readers at the new tabs', () => {
		const src = source();
		const tipsSection = src.split('<section id="tips"')[1]?.split('<section id="archivists"')[0] || '';
		expect(tipsSection).toMatch(/Roadmap/);
		expect(tipsSection).toMatch(/Requests/);
	});
});
