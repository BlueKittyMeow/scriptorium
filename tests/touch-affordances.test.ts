import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * User-guide audit fixes (touch reachability):
 *
 * 1. Library card rename pencil was hover-only (`.novel-card:hover .rename-btn`),
 *    unreachable on phones/tablets. Fixed with the same `pointer: coarse`
 *    media-query rule the workspace binder rows already use for their
 *    row actions (src/routes/novels/[id]/+page.svelte `.node-actions`).
 *
 * 2. The `?` Help link lives in the top bar, which the workspace hides on
 *    mobile (by design — 100dvh layout). The binder drawer (opened via ☰)
 *    is the one piece of chrome still reachable on a mobile workspace, so
 *    a Help entry was added to a mobile-only drawer footer there.
 */

describe('library card: rename pencil reachable on touch devices', () => {
	const SOURCE = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

	it('keeps the hover reveal as the desktop default', () => {
		expect(SOURCE).toMatch(/\.novel-card:hover \.rename-btn\s*\{[^}]*opacity:\s*1/);
	});

	it('adds a `pointer: coarse` media query that keeps the pencil visible on touch', () => {
		const match = SOURCE.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\t\}/);
		expect(match).toBeTruthy();
		const block = match![1];
		expect(block).toMatch(/\.rename-btn\s*\{[^}]*opacity:\s*1/);
	});
});

describe('workspace binder rows: existing pointer-coarse precedent', () => {
	const SOURCE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

	it('reveals .node-actions permanently on coarse-pointer (touch) devices', () => {
		expect(SOURCE).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?\.tree-item \.node-actions[\s\S]*?display:\s*flex/);
	});
});

describe('mobile workspace: Help reachable without the top bar', () => {
	const WORKSPACE_SOURCE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
	const LAYOUT_SOURCE = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

	it('confirms the top bar (and its Help link) is hidden on the mobile workspace by design', () => {
		expect(LAYOUT_SOURCE).toMatch(/\.top-bar\.on-workspace\s*\{[^}]*display:\s*none/);
	});

	it('adds a Help link inside the binder drawer, the mobile-reachable chrome (via ☰)', () => {
		expect(WORKSPACE_SOURCE).toContain('<a href="/help" class="sidebar-help-link">? Help</a>');
	});

	it('hides the drawer Help footer on desktop (top bar already covers it there)', () => {
		const beforeMedia = WORKSPACE_SOURCE.split('@media (max-width: 768px)')[0];
		expect(beforeMedia).toMatch(/\.sidebar-footer\s*\{[^}]*display:\s*none/);
	});

	it('shows the drawer Help footer within the <=768px mobile media query', () => {
		const mobileBlockStart = WORKSPACE_SOURCE.indexOf('@media (max-width: 768px)');
		expect(mobileBlockStart).toBeGreaterThan(-1);
		const mobileBlock = WORKSPACE_SOURCE.slice(mobileBlockStart);
		expect(mobileBlock).toMatch(/\.sidebar-footer\s*\{[^}]*display:\s*block/);
	});
});
