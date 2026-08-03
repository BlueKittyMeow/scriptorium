import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Mobile: the document scrolls, not a box inside it.
 *
 * Reported on Android: select a paragraph mid-document, drag the handle past
 * the bottom of the screen, then scroll back up — everything from the top of
 * the document was selected. Scroll down and everything to the bottom was.
 *
 * Diagnosed by building a plain-HTML harness (no ProseMirror, no app CSS) and
 * testing on the actual phone:
 *   A  nested overflow-y:auto scroller, plain HTML  → REPRODUCED
 *   C  same plus our user-select:none chrome        → reproduced, chrome stayed unselected
 *   B  plain HTML, document scroll (like /help)     → clean
 *   F  document scroll + sticky header/footer       → clean  ← shipped shape
 * So the nested scroll container alone was sufficient: Chrome on Android ties
 * selection-handle extension to the scrolling element, and inside a nested
 * scroller it runs to that box's start or end instead of tracking your finger.
 * Not ProseMirror, and not the user-select rules.
 *
 * Desktop keeps the nested scroller — the bug doesn't occur there and the
 * fixed-height editor is wanted.
 */

const EDITOR = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');
const WORKSPACE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

const MOBILE = '@media (max-width: 768px)';
const editorMobile = EDITOR.slice(EDITOR.indexOf(MOBILE));
const workspaceMobile = WORKSPACE.slice(WORKSPACE.indexOf(MOBILE));
/** Everything before the mobile block — i.e. the desktop rules. */
const editorDesktop = EDITOR.slice(0, EDITOR.indexOf(MOBILE));

function rule(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `${selector} is declared`).toBeTruthy();
	return match![1];
}

describe('Mobile: the editor gives up its nested scroller', () => {
	it('lets the prose scroll with the document', () => {
		expect(rule(editorMobile, '.editor-scroll')).toMatch(/overflow-y:\s*visible/);
	});

	it('keeps the container at least a screen tall, so short docs still fill it', () => {
		const container = rule(editorMobile, '.editor-container');
		expect(container).toMatch(/height:\s*auto/);
		expect(container).toMatch(/min-height:\s*100dvh/);
	});

	it('pins the header and footer instead, so nothing moves for the writer', () => {
		const header = rule(editorMobile, '.editor-header');
		expect(header).toMatch(/position:\s*sticky/);
		expect(header).toMatch(/top:\s*0/);
		const footer = rule(editorMobile, '.editor-footer');
		expect(footer).toMatch(/position:\s*sticky/);
		expect(footer).toMatch(/bottom:\s*0/);
	});

	it('keeps the sticky chrome below the binder button, which must stay tappable', () => {
		// .binder-reopen is z-index 40.
		const z = Number(rule(editorMobile, '.editor-header').match(/z-index:\s*(\d+)/)?.[1]);
		expect(z).toBeGreaterThan(0);
		expect(z).toBeLessThan(40);
	});
});

describe('Mobile: the shell stops clipping', () => {
	it('drops the fixed viewport height on the workspace', () => {
		const workspace = rule(workspaceMobile, '.workspace');
		expect(workspace).toMatch(/height:\s*auto/);
		expect(workspace).toMatch(/min-height:\s*100dvh/);
	});

	it('lifts overflow:hidden off both ancestors', () => {
		// Not cosmetic: an overflow:hidden ancestor becomes the scrollport and
		// silently breaks position:sticky inside it. .editor-wrapper was exactly
		// this — the header scrolled away until it was included.
		expect(workspaceMobile).toMatch(
			/\.editor-area,\s*\n\s*\.editor-wrapper \{[^}]*overflow:\s*visible/
		);
	});

	it('sticks the snapshot preview banner, which holds Restore and Back', () => {
		const banner = rule(workspaceMobile, '.preview-banner');
		expect(banner).toMatch(/position:\s*sticky/);
		expect(banner).toMatch(/top:\s*0/);
	});
});

describe('Desktop keeps the nested scroller', () => {
	it('still scrolls inside .editor-scroll above the breakpoint', () => {
		expect(rule(editorDesktop, '.editor-scroll')).toMatch(/overflow-y:\s*auto/);
	});

	it('leaves the header and footer in normal flow', () => {
		expect(rule(editorDesktop, '.editor-header')).not.toContain('position:');
		expect(rule(editorDesktop, '.editor-footer')).not.toContain('position:');
	});
});

describe('No JavaScript depends on the scroll container', () => {
	it('has no scrollContainer binding left', () => {
		// It was bound and never read. Removing it matters because leaving it
		// implies the nested scroller is load-bearing for JS, which it is not:
		// Find scrolls via ProseMirror's .scrollIntoView(), which walks
		// ancestors and works the same when the document is the scroller.
		expect(EDITOR).not.toContain('scrollContainer');
	});

	it('still scrolls to a find match through ProseMirror', () => {
		expect(EDITOR).toMatch(/\.scrollIntoView\(\)/);
	});
});
