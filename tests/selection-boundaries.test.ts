import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Selection boundaries — the prose is selectable, the chrome around it is not.
 *
 * Reported from a phone in read mode: selecting part of a document and then
 * scrolling extends the selection through whatever chrome scrolls past, so the
 * document title, toolbar labels, word count and save status all landed in the
 * copied text. Header and footer opt out of selection; the content area and the
 * text fields inside the header opt back in.
 *
 * Source-grep style, matching tests/editor-read-mode.test.ts — these are CSS
 * declarations, so there is nothing to evaluate, only wiring to assert.
 */

const EDITOR = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
const LAYOUT = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');
const WORKSPACE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

/** The body of a CSS rule, given its selector, verbatim from the source. */
function rule(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`(?:^|\\n)\\t${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `${selector} is declared`).toBeTruthy();
	return match![1];
}

/** Both the prefixed and unprefixed property — iOS Safari still needs -webkit-. */
function expectUserSelect(body: string, value: 'none' | 'text') {
	expect(body).toMatch(new RegExp(`-webkit-user-select:\\s*${value}`));
	expect(body).toMatch(new RegExp(`(?<!-)\\buser-select:\\s*${value}`));
}

describe('Editor: chrome is not selectable', () => {
	it('excludes the header — title, toolbar and find bar live there', () => {
		expectUserSelect(rule(EDITOR, '.editor-header'), 'none');
	});

	it('excludes the footer — word count, snapshot buttons and save status', () => {
		expectUserSelect(rule(EDITOR, '.editor-footer'), 'none');
	});

	it('excludes the snapshot preview banner, which sits above its own scroll area', () => {
		expectUserSelect(rule(WORKSPACE, '.preview-banner'), 'none');
	});

	it('excludes every button app-wide, from the layout', () => {
		expectUserSelect(rule(LAYOUT, ':global(button)'), 'none');
	});
});

describe('Editor: the prose stays selectable', () => {
	it('states user-select on the content area explicitly', () => {
		expectUserSelect(rule(EDITOR, '.editor-content'), 'text');
	});

	it('does not opt the scroll container out — it wraps the content', () => {
		expect(rule(EDITOR, '.editor-scroll')).not.toContain('user-select');
	});
});

describe('Editor: header text fields opt back in', () => {
	// A text field that inherits user-select:none loses its selection handles
	// and caret dragging on iOS, so renaming or editing a find term breaks.
	it('re-enables selection inside the title rename field', () => {
		expectUserSelect(rule(EDITOR, '.doc-title-input'), 'text');
	});

	it('re-enables selection inside the find field', () => {
		expectUserSelect(rule(EDITOR, '.find-input'), 'text');
	});
});

describe('Editor: copying the title', () => {
	const copyFn = EDITOR.match(/async function copyTitle\([\s\S]*?\n\t\}/)?.[0] || '';

	it('defines the handler', () => {
		expect(copyFn).toBeTruthy();
	});

	it('copies the title as plain text — a title has no formatting to keep', () => {
		expect(copyFn).toContain('navigator.clipboard.writeText(title)');
	});

	it('reports success and failure transiently, like the document Copy button', () => {
		expect(copyFn).toMatch(/try \{[\s\S]*\} catch/);
		expect(EDITOR).toMatch(/let titleCopyFlash[^=]*= \$state\('idle'\)/);
		expect(copyFn).toMatch(/setTimeout\(\(\) => \{ titleCopyFlash = 'idle'; \}, 2000\)/);
	});

	it('renders a button in the title row, independent of the rename pencil', () => {
		const titleRow = EDITOR.match(/<div class="title-row">[\s\S]*?\n\t\t<\/div>/)?.[0] || '';
		expect(titleRow).toBeTruthy();
		expect(titleRow).toContain('onclick={copyTitle}');
		// Inside the row but outside the {#if onrename} block — a read-only
		// document still needs a way to get its title out.
		const renameGated = titleRow.match(/\{#if onrename\}[\s\S]*?\{\/if\}/)?.[0] || '';
		expect(renameGated).toBeTruthy();
		expect(renameGated).not.toContain('copyTitle');
	});

	it('labels the button for screen readers, not just by its glyph', () => {
		expect(EDITOR).toContain('aria-label="Copy the document title"');
	});

	it('gives it a real touch target on phones, alongside the rename pencil', () => {
		const mobileBlock = EDITOR.slice(EDITOR.indexOf('@media (max-width: 768px)'));
		expect(mobileBlock).toMatch(/\.title-copy-btn\s*\{[^}]*min-height:\s*2rem/);
	});

	it('clears its timeout on destroy so it cannot fire after teardown', () => {
		const onDestroyFn = EDITOR.match(/onDestroy\(\(\) => \{[\s\S]*?\n\t\}\);/)?.[0] || '';
		expect(onDestroyFn).toContain('clearTimeout(titleCopyTimeout)');
	});
});
