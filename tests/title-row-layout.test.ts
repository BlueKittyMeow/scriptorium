import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * The document title row vs. the fixed top bar.
 *
 * Reported from a 948px-wide window: the rename pencil and the title copy
 * button sat at the far right of the header, tangled up with Sign Out and the
 * theme toggle. Cause: `.doc-title` was `flex: 1`, so it stretched to fill the
 * row and pushed both buttons to its right edge — directly underneath the
 * fixed `.top-bar` (z-index 200). Verified in the browser at 430/600/768/820/
 * 948/1024/1200/1440px before and after.
 *
 * Two rules keep it fixed, and both matter:
 *   1. the title is sized to its text, so the buttons stay beside it;
 *   2. the row reserves the bar's measured width, so a long title (or the
 *      rename input, which does stretch) can't slide under it either.
 */

const EDITOR = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
const LAYOUT = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

function rule(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`(?:^|\\n)\\t${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `${selector} is declared`).toBeTruthy();
	return match![1];
}

describe('Title row: buttons stay beside the title', () => {
	const title = rule(EDITOR, '.doc-title');

	it('sizes the title to its text instead of stretching it', () => {
		// `flex: 1` here is the bug — it pushes the buttons to the row's edge.
		expect(title).toMatch(/flex:\s*0 1 auto/);
		expect(title).not.toMatch(/flex:\s*1\s*;/);
	});

	it('truncates a long title rather than overflowing the row', () => {
		expect(title).toMatch(/overflow:\s*hidden/);
		expect(title).toMatch(/text-overflow:\s*ellipsis/);
		expect(title).toMatch(/white-space:\s*nowrap/);
		expect(title).toMatch(/min-width:\s*0/);
	});

	it('keeps a truncated title readable on hover', () => {
		expect(EDITOR).toMatch(/<h1 class="doc-title" title=\{title\}>/);
	});

	it('does not wrap the row — wrapping drops the buttons to a second line', () => {
		// Flexbox decides wrapping from each item's *preferred* width, so a long
		// title bumped the buttons onto their own row even at 1200px, making the
		// header taller on most desktop widths. Measured, then reverted.
		expect(rule(EDITOR, '.title-row')).not.toContain('flex-wrap');
	});
});

describe('Title row: reserves the fixed top bar footprint', () => {
	it('pads the row by the measured bar width', () => {
		expect(rule(EDITOR, '.title-row')).toMatch(
			/padding-right:\s*calc\(var\(--top-bar-width,\s*0px\)\s*\+/
		);
	});

	it('falls back to 0px, so the reserve vanishes where no bar is overhead', () => {
		// Mobile hides the bar on the workspace; the fallback keeps the row's
		// normal gutter rather than a mystery gap.
		expect(rule(EDITOR, '.title-row')).toContain('var(--top-bar-width, 0px)');
	});
});

describe('Layout: publishes the top bar width', () => {
	it('measures the bar rather than hardcoding a width', () => {
		// It grows with the username — "UponMidnight archivist Admin Sign Out"
		// measured 353px, a short name far less.
		expect(LAYOUT).toMatch(/<div class="top-bar"[^>]*bind:clientWidth=\{topBarWidth\}/);
		expect(LAYOUT).toMatch(/let topBarWidth = \$state\(0\)/);
	});

	it('publishes it as a custom property on the document root', () => {
		expect(LAYOUT).toMatch(
			/setProperty\('--top-bar-width',\s*`\$\{topBarWidth\}px`\)/
		);
	});
});
