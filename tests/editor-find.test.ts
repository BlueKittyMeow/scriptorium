import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Find within the open document (the Find button + Ctrl+F bar in the editor
 * header) and the theme variables its highlights depend on.
 *
 * Source-grep style, matching tests/editor-rename.test.ts: these assert the
 * wiring exists rather than mounting the Svelte component. The matching rules
 * themselves are covered properly in tests/find-matches.test.ts.
 */

const EDITOR_PATH = 'src/lib/components/Editor.svelte';
const LAYOUT_PATH = 'src/routes/+layout.svelte';

const EDITOR = fs.readFileSync(EDITOR_PATH, 'utf-8');
const LAYOUT = fs.readFileSync(LAYOUT_PATH, 'utf-8');

/** Bodies of the functions that make up the find feature. */
function findFunctionBodies(): string {
	const names = [
		'collectMatches',
		'findDecorations',
		'refreshFind',
		'queueFindRefresh',
		'gotoMatch',
		'nextMatch',
		'prevMatch',
		'runFind',
		'openFind',
		'closeFind',
		'handleWindowKeydown'
	];
	return names
		.map((name) => {
			const match = EDITOR.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\t\\}`));
			expect(match, `expected a ${name}() function in ${EDITOR_PATH}`).toBeTruthy();
			return match?.[0] ?? '';
		})
		.join('\n');
}

describe('Editor: find uses its own decoration plugin', () => {
	it('declares a find PluginKey distinct from the cross-document search key', () => {
		expect(EDITOR).toMatch(/const findKey = new PluginKey\(/);
		expect(EDITOR).toMatch(/const highlightKey = new PluginKey\(/);

		const findName = EDITOR.match(/const findKey = new PluginKey\('([^']+)'\)/)?.[1];
		const highlightName = EDITOR.match(/const highlightKey = new PluginKey\('([^']+)'\)/)?.[1];
		expect(findName).toBeTruthy();
		expect(highlightName).toBeTruthy();
		expect(findName).not.toBe(highlightName);
	});

	it('registers a separate extension alongside SearchHighlight', () => {
		expect(EDITOR).toMatch(/const FindInDocument = Extension\.create\(/);
		const extensions = EDITOR.match(/extensions: \[[\s\S]*?\n\t\t\t\]/)?.[0] || '';
		expect(extensions).toContain('SearchHighlight');
		expect(extensions).toContain('FindInDocument');
	});

	it('paints every match, and the current one distinctly', () => {
		expect(EDITOR).toContain("'find-match find-match-current'");
		expect(EDITOR).toMatch(/:\s*'find-match'/);
		expect(EDITOR).toMatch(/:global\(\.find-match\)/);
		expect(EDITOR).toMatch(/:global\(\.find-match-current\)/);
	});

	it('builds matches from the shared, ProseMirror-free helper', () => {
		expect(EDITOR).toMatch(/import \{ findOffsets \} from '\$lib\/find-matches'/);
		const collect = EDITOR.match(/function collectMatches\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(collect).toContain('findOffsets');
		// Per text block, not per text node — that's what lets a match span an
		// italic run without ever spanning a paragraph break.
		expect(collect).toContain('isTextblock');
	});
});

describe('Editor: find highlight colours are themed', () => {
	it('defines --find-match and --find-match-current in the light theme block', () => {
		const light = LAYOUT.split(':global(:root[data-theme="dark"])')[0];
		expect(light).toMatch(/--find-match:\s*[^;]+;/);
		expect(light).toMatch(/--find-match-current:\s*[^;]+;/);
	});

	it('defines --find-match and --find-match-current in the dark theme block', () => {
		const dark = LAYOUT.split(':global(:root[data-theme="dark"])')[1] || '';
		expect(dark).toBeTruthy();
		expect(dark).toMatch(/--find-match:\s*[^;]+;/);
		expect(dark).toMatch(/--find-match-current:\s*[^;]+;/);
	});

	it('uses the variables rather than literal colours in the editor styles', () => {
		expect(EDITOR).toContain('background: var(--find-match)');
		expect(EDITOR).toContain('background: var(--find-match-current)');
	});

	it('does not animate the find highlights away like the cross-document flash', () => {
		const findMatchRule = EDITOR.match(/:global\(\.find-match\)\s*\{[^}]*\}/)?.[0] || '';
		expect(findMatchRule).toBeTruthy();
		expect(findMatchRule).not.toMatch(/animation/);
	});
});

describe('Editor: find keyboard handling', () => {
	it('handles Ctrl/Cmd+F on the window and prevents the browser default', () => {
		const handler = EDITOR.match(/function handleWindowKeydown\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(handler).toBeTruthy();
		expect(handler).toMatch(/e\.ctrlKey \|\| e\.metaKey/);
		expect(handler).toMatch(/e\.key === 'f'/);
		expect(handler).toContain('e.preventDefault()');
		expect(EDITOR).toMatch(/<svelte:window onkeydown={handleWindowKeydown} \/>/);
	});

	it('leaves Ctrl+K (the workspace cross-document search) alone', () => {
		expect(EDITOR).not.toMatch(/e\.key === 'k'/i);
	});

	it('does not steal keys while the doc-title rename input is open', () => {
		const handler = EDITOR.match(/function handleWindowKeydown\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(handler).toMatch(/if \(editingTitle\) return;/);
	});

	it('closes on Escape', () => {
		const handler = EDITOR.match(/function handleWindowKeydown\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(handler).toMatch(/e\.key === 'Escape'[\s\S]*closeFind\(\)/);
	});

	it('navigates with Enter and Shift+Enter from the find input', () => {
		const bar = EDITOR.match(/<div class="find-bar">[\s\S]*?<\/div>/)?.[0] || '';
		expect(bar).toBeTruthy();
		expect(bar).toMatch(/e\.key === 'Enter'[\s\S]*?if \(e\.shiftKey\) prevMatch\(\); else nextMatch\(\);/);
	});

	it('opens with the find input focused, never the editor', () => {
		const open = EDITOR.match(/function openFind\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(open).toMatch(/findInputEl\?\.focus\(\)/);
		expect(open).not.toMatch(/editor[^\n]*\.focus\(\)/);
		expect(open).not.toMatch(/chain\(\)\.focus\(\)/);
	});

	it('clears the term, the matches and the decorations on close', () => {
		const close = EDITOR.match(/function closeFind\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(close).toMatch(/findTerm = ''/);
		expect(close).toMatch(/findMatches = \[\]/);
		expect(close).toContain('DecorationSet.empty');
	});
});

describe('Editor: find navigation', () => {
	it('wraps around at both ends', () => {
		const goto = EDITOR.match(/function gotoMatch\([\s\S]*?\n\t\}/)?.[0] || '';
		// Modulo twice so a negative index (stepping back from the first match)
		// lands on the last one rather than out of range.
		expect(goto).toMatch(/\(\(index % count\) \+ count\) % count/);
		expect(EDITOR).toMatch(/function nextMatch\(\) \{ gotoMatch\(findIndex \+ 1\); \}/);
		expect(EDITOR).toMatch(/function prevMatch\(\) \{ gotoMatch\(findIndex - 1\); \}/);
	});

	it('scrolls the match into view via the transaction, not editor.focus()', () => {
		const goto = EDITOR.match(/function gotoMatch\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(goto).toContain('tr.scrollIntoView()');
		expect(goto).toContain('TextSelection.create');
	});

	it('never focuses the editor anywhere in the find path (it would pop the phone keyboard)', () => {
		const bodies = findFunctionBodies();
		expect(bodies).not.toMatch(/editor[^\n]*\.focus\(\)/);
		expect(bodies).not.toMatch(/chain\(\)\.focus\(\)/);
	});

	it('clamps a stale position instead of throwing after an edit', () => {
		const goto = EDITOR.match(/function gotoMatch\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(goto).toContain('Math.min(match.from');
		expect(goto).toMatch(/catch \{[\s\S]*refreshFind/);
	});
});

describe('Editor: find recomputation', () => {
	it('recomputes when the document changes while the bar is open', () => {
		expect(EDITOR).toMatch(/onTransaction: \(\{ transaction \}\)[\s\S]*transaction\.docChanged[\s\S]*queueFindRefresh\(\)/);
	});

	it('skips recomputation entirely when the bar is closed', () => {
		const queue = EDITOR.match(/function queueFindRefresh\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(queue).toMatch(/if \(!findOpen[^)]*\) return;/);
		const refresh = EDITOR.match(/function refreshFind\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(refresh).toMatch(/if \(!findOpen[^)]*\) return;/);
	});

	it('recomputes from the top when the term changes', () => {
		const run = EDITOR.match(/function runFind\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(run).toMatch(/findTerm = term/);
		expect(run).toMatch(/refreshFind\(true\)/);
	});
});

describe('Editor: find bar UI', () => {
	it('offers a Find button in the toolbar, in read mode as well as edit mode', () => {
		const toolbarStart = EDITOR.indexOf('<div class="editor-toolbar">');
		expect(toolbarStart).toBeGreaterThan(-1);
		const toolbar = EDITOR.slice(toolbarStart, EDITOR.indexOf('{#if findOpen}'));
		expect(toolbar).toBeTruthy();
		// The edit-only controls sit inside {#if mode === 'edit'}; Find must be
		// outside it, next to Copy.
		const afterEditOnly = toolbar.split('{/if}').pop() || '';
		expect(afterEditOnly).toContain('copyDocument');
		expect(afterEditOnly).toMatch(/>Find</);
	});

	it('labels the previous/next/close buttons for screen readers', () => {
		const bar = EDITOR.match(/<div class="find-bar">[\s\S]*?<\/div>/)?.[0] || '';
		expect(bar).toContain('aria-label="Previous match"');
		expect(bar).toContain('aria-label="Next match"');
		expect(bar).toContain('aria-label="Close find"');
		expect(bar).toContain('placeholder="Find in document"');
	});

	it('shows a match counter that reads "n of m", or "No matches"', () => {
		expect(EDITOR).toContain("'No matches'");
		expect(EDITOR).toMatch(/\$\{findIndex \+ 1\} of \$\{findMatches\.length\}/);
		// Empty term → empty counter, so an untouched bar isn't shouting at you.
		expect(EDITOR).toMatch(/findTerm\.trim\(\) === ''\s*\n?\s*\?\s*''/);
	});

	it('keeps the find input at 16px on phones so iOS does not zoom', () => {
		const mediaBlockStart = EDITOR.indexOf('@media (max-width: 768px)');
		expect(mediaBlockStart).toBeGreaterThan(-1);
		const mobileBlock = EDITOR.slice(mediaBlockStart);
		expect(mobileBlock).toMatch(/\.find-input\s*\{[^}]*font-size:\s*16px/);
		expect(mobileBlock).toMatch(/\.find-bar \.tb-btn\s*\{[^}]*min-height:\s*2rem/);
	});
});
