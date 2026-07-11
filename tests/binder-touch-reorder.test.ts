import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Binder QoL batch (touch reorder/move, new-doc parent default, modal autofocus):
 *
 * 1. HTML5 drag-and-drop never fires on touch, so phones couldn't reorder the
 *    binder at all. Added ↑/↓/"Move into…" controls, gated to coarse pointers
 *    only (desktop keeps pure DnD — same precedent as .node-actions itself
 *    and the library page's card-menu, see touch-affordances.test.ts).
 * 2. "+ Doc" used to always create at root; it now defaults to the active
 *    document's parent folder (src/lib/binder-tree.ts: getDefaultDocumentParent,
 *    unit-tested in tests/binder-tree-helpers.test.ts).
 * 3. The New-item modal now autofocuses its title input (same pattern as the
 *    existing rename inputs) and shows a "in <folder>" hint when a parent is
 *    preselected.
 */

const SOURCE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

describe('binder rows: touch-only up/down move controls', () => {
	it('imports the shared reorder-math helpers from $lib/binder-tree', () => {
		expect(SOURCE).toMatch(/from '\$lib\/binder-tree\.js'/);
		expect(SOURCE).toContain('computeSwapMove');
	});

	it('has a moveNode handler that calls the same reorder endpoint the drop handler uses', () => {
		const fnStart = SOURCE.indexOf('async function moveNode');
		expect(fnStart).toBeGreaterThan(-1);
		const fn = SOURCE.slice(fnStart, SOURCE.indexOf('\n\t}', fnStart));
		expect(fn).toContain(`/api/novels/${'${novelId}'}/tree`);
		expect(fn).toMatch(/method:\s*'PUT'/);
		expect(fn).toContain('computeSwapMove');
	});

	it('renders an up and a down button wired to moveNode', () => {
		expect(SOURCE).toMatch(/moveNode\(node,\s*'up'\)/);
		expect(SOURCE).toMatch(/moveNode\(node,\s*'down'\)/);
	});

	it('disables the up/down buttons at the sibling boundary', () => {
		// Some disabled={...} guard should reference first/last sibling state
		expect(SOURCE).toMatch(/disabled={[^}]*(isFirst|First)[^}]*}/);
		expect(SOURCE).toMatch(/disabled={[^}]*(isLast|Last)[^}]*}/);
	});
});

describe('binder rows: touch-only "Move into…" picker', () => {
	it('has an openMoveModal / moveModalNode state pair', () => {
		expect(SOURCE).toMatch(/moveModalNode/);
		expect(SOURCE).toMatch(/showMoveModal/);
	});

	it('computes picker targets via the shared getMoveTargets helper (excludes descendants)', () => {
		expect(SOURCE).toContain('getMoveTargets');
	});

	it('re-parents via moveNodeInto using the shared computeAppendSortOrder helper', () => {
		const fnStart = SOURCE.indexOf('async function moveNodeInto');
		expect(fnStart).toBeGreaterThan(-1);
		const fn = SOURCE.slice(fnStart, SOURCE.indexOf('\n\t}', fnStart));
		expect(fn).toContain('computeAppendSortOrder');
		expect(fn).toMatch(/method:\s*'PUT'/);
	});

	it('the move-into modal is a proper aria-modal dialog', () => {
		const modalSection = SOURCE.slice(SOURCE.indexOf('showMoveModal && moveModalNode'));
		const dialogEl = modalSection.match(/role="dialog"[^>]*/)?.[0] ?? '';
		expect(dialogEl).toContain('aria-modal="true"');
	});

	it('refreshes the tree the same way the drop handler does after a successful move', () => {
		const fnStart = SOURCE.indexOf('async function moveNodeInto');
		const fn = SOURCE.slice(fnStart, SOURCE.indexOf('\n\t}', fnStart));
		expect(fn).toContain('loadTree()');
	});
});

describe('binder rows: new touch controls are gated to coarse pointers, invisible on desktop', () => {
	it('has a touch-only class default-hidden outside the coarse-pointer query', () => {
		const beforeMedia = SOURCE.split('@media (pointer: coarse)')[0];
		// whatever class gates the new controls must default to display: none
		// so hovering a row on desktop does not reveal them
		expect(beforeMedia).toMatch(/\.node-menu-btn\s*\{[^}]*display:\s*none/);
	});

	it('reveals the touch-only controls inside the existing coarse-pointer block, after the default-hidden declaration (cascade order)', () => {
		const mediaIdx = SOURCE.indexOf('@media (pointer: coarse)');
		expect(mediaIdx).toBeGreaterThan(-1);
		const hiddenIdx = SOURCE.indexOf('.node-menu-btn {');
		expect(hiddenIdx).toBeGreaterThan(-1);
		expect(hiddenIdx).toBeLessThan(mediaIdx); // plain rule must come first so the media override wins on touch

		const afterMedia = SOURCE.slice(mediaIdx);
		expect(afterMedia).toMatch(/\.node-menu-btn\s*\{[^}]*display:\s*inline-block/);
	});
});

describe('new document defaults to the active document\'s parent folder', () => {
	it('imports getDefaultDocumentParent from the shared binder-tree helpers', () => {
		expect(SOURCE).toContain('getDefaultDocumentParent');
	});

	it('the top-of-binder "+ Doc" button passes the active parent, not a hardcoded null', () => {
		expect(SOURCE).toMatch(/openNewModal\('document',\s*getDefaultDocumentParent\(/);
	});

	it('the folder-row "+" (explicit parent) is unchanged', () => {
		expect(SOURCE).toContain("openNewModal('document', node.id)");
	});
});

describe('New-item modal: shows destination when a parent is preselected', () => {
	it('derives a human-readable parent title for the hint line', () => {
		expect(SOURCE).toMatch(/newItemParentTitle/);
	});

	it('renders a muted "in <folder>" hint inside the modal', () => {
		expect(SOURCE).toMatch(/in \{newItemParentTitle\}/);
	});
});

describe('New-item modal: title input autofocuses, Escape still closes', () => {
	it('the title input has the autofocus attribute with the a11y svelte-ignore precedent', () => {
		const modalStart = SOURCE.indexOf('{#if showNewModal}');
		expect(modalStart).toBeGreaterThan(-1);
		const modalSection = SOURCE.slice(modalStart, modalStart + 1500);
		expect(modalSection).toMatch(/svelte-ignore a11y_autofocus/);
		expect(modalSection).toMatch(/bind:value={newItemTitle}[\s\S]*?autofocus/);
	});

	it('also drives focus via an $effect (bare autofocus doesn\'t survive a button-click open — verified live: Chromium keeps focus on the clicked trigger)', () => {
		const modalStart = SOURCE.indexOf('{#if showNewModal}');
		const modalSection = SOURCE.slice(modalStart, modalStart + 1500);
		expect(modalSection).toContain('bind:this={newItemTitleEl}');
		expect(SOURCE).toMatch(/\$effect\(\(\) => \{\s*if \(showNewModal && newItemTitleEl\)/);
		expect(SOURCE).toContain('newItemTitleEl?.focus()');
	});

	it('Enter still submits via createItem', () => {
		expect(SOURCE).toMatch(/onkeydown={\(e\) => e\.key === 'Enter' && createItem\(\)}/);
	});

	it('Escape still closes the modal', () => {
		expect(SOURCE).toMatch(/onkeydown={\(e\) => e\.key === 'Escape' && \(showNewModal = false\)}/);
	});
});
