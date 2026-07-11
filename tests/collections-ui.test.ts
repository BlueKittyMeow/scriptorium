import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Library Collections v2 — UI source-grep battery (house pattern). The library
 * page is a large Svelte component; these structural greps lock in the shelf
 * hierarchy, both chevron levels, collapse persistence, the shelf baseline,
 * version-stack render + expand, drag-and-drop handlers, the Move-to/Stack
 * card controls, and the manage-shelves modal.
 */
const SOURCE = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

describe('server load + client refresh wiring', () => {
	it('receives collections from the server load and refetches them after edits', () => {
		expect(SOURCE).toContain('data.collections');
		expect(SOURCE).toContain("fetch('/api/collections')");
		expect(SOURCE).toContain('loadCollections');
	});
});

describe('hierarchical shelf render', () => {
	it('renders top-level universes and their child eras', () => {
		expect(SOURCE).toContain('topLevels');
		expect(SOURCE).toContain('childrenOf(top.id)');
		expect(SOURCE).toContain('universe-header');
		expect(SOURCE).toContain('era-header');
	});

	it('has an Unsorted section for unassigned novels, rendered only when non-empty', () => {
		expect(SOURCE).toContain('Unsorted');
		expect(SOURCE).toMatch(/novelsIn\(null\)\.length > 0/);
	});

	it('draws both chevron levels (collapse indicators)', () => {
		expect(SOURCE).toContain('class="chevron"');
		expect(SOURCE).toMatch(/isCollapsed\([^)]*\) \? '▸' : '▾'/);
	});
});

describe('collapse state persistence', () => {
	it('persists collapse state under the SSR-guarded localStorage key', () => {
		expect(SOURCE).toContain('scriptorium-collections-collapsed');
		expect(SOURCE).toContain("typeof localStorage !== 'undefined'");
		expect(SOURCE).toContain('toggleCollapse');
	});
});

describe('shelf baseline (bookshelf look, CSS variables only)', () => {
	it('renders a shelf-baseline element styled from theme variables', () => {
		expect(SOURCE).toContain('shelf-baseline');
		const styleBlock = SOURCE.match(/<style>([\s\S]*?)<\/style>/)![1];
		const baselineRule = styleBlock.match(/\.shelf-baseline\s*\{[^}]*\}/)![0];
		// gradient/shadow driven by variables, no hardcoded hex colors
		expect(baselineRule).toMatch(/var\(--/);
		expect(baselineRule).not.toMatch(/#[0-9a-fA-F]{3,6}/);
	});
});

describe('version stacks', () => {
	it('groups novels sharing a stack_label and shows a "N versions" chip', () => {
		expect(SOURCE).toContain('shelfItems');
		expect(SOURCE).toContain('stack_label');
		expect(SOURCE).toMatch(/versions/);
		expect(SOURCE).toContain('stack-chip');
	});

	it('renders offset card edges behind the front card', () => {
		expect(SOURCE).toContain('stack-edge');
		expect(SOURCE).toContain('stack-cluster');
	});

	it('expands a stack in place via a toggle handler (ephemeral state)', () => {
		expect(SOURCE).toContain('toggleStackExpand');
		expect(SOURCE).toContain('expandedStacks');
	});
});

describe('assignment interactions', () => {
	it('wires HTML5 drag-and-drop from cards onto collection headers', () => {
		expect(SOURCE).toContain('draggable="true"');
		expect(SOURCE).toContain('onCardDragStart');
		expect(SOURCE).toContain('onHeaderDrop');
		expect(SOURCE).toContain('drop-target');
	});

	it('suppresses card <a> navigation when a drag occurred', () => {
		expect(SOURCE).toContain('suppressCardNav');
		expect(SOURCE).toContain('dragOccurred');
	});

	it('offers a Move-to control listing all collections plus Unsorted', () => {
		expect(SOURCE).toContain('Move to…');
		expect(SOURCE).toContain('assignCollection');
		expect(SOURCE).toContain('card-menu-item indented');
	});

	it('offers a Stack control to set/clear a label with quick choices + free text', () => {
		expect(SOURCE).toContain('Stack…');
		expect(SOURCE).toContain('setStackLabel');
		expect(SOURCE).toContain('stackLabelsIn');
		expect(SOURCE).toContain('Clear stack');
	});
});

describe('manage shelves modal', () => {
	it('has an Edit shelves affordance and a modal', () => {
		expect(SOURCE).toContain('Edit shelves');
		expect(SOURCE).toContain('manage-modal');
		expect(SOURCE).toContain('aria-modal="true"');
	});

	it('creates (with parent picker), renames, reorders, and deletes with a count-stating confirm', () => {
		expect(SOURCE).toContain('createCollection');
		expect(SOURCE).toContain('renameCollection');
		expect(SOURCE).toContain('moveCollection');
		expect(SOURCE).toContain('deleteMemberCount');
		expect(SOURCE).toContain('deleteChildCount');
		expect(SOURCE).toMatch(/fall to Unsorted/);
		expect(SOURCE).toMatch(/promote to top-level/);
	});

	it('novel-card anchor stays display:block inside card-wrap (inline-fragmentation regression)', () => {
		// The card is an <a> wrapped in .card-wrap, so it is no longer a grid
		// item and must declare display:block itself — without it the inline
		// box fragments around its block children (bars, clipped badges).
		expect(SOURCE).toMatch(/\.novel-card \{[^}]*display: block/s);
	});
});
