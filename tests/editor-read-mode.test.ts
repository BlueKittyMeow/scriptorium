import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Read/Edit mode toggle + the copy-document button (editor toolbar).
 *
 * Source-grep style, matching tests/editor-rename.test.ts: these assert the
 * wiring exists rather than mounting the Svelte component (no request-level
 * harness for this UI). The mode initialiser is the one exception — its
 * expression is extracted and evaluated against a stubbed localStorage, so
 * "defaults to read" is a real assertion rather than a text match.
 */

const SOURCE = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

/** The expression passed to $state() for `mode`, verbatim from the source. */
function modeInitialiser(): string {
	const match = SOURCE.match(/let mode = \$state<'read' \| 'edit'>\(([\s\S]*?)\n\t\);/);
	expect(match, 'mode is declared as $state<"read" | "edit">(…)').toBeTruthy();
	return match![1];
}

/** Evaluate the initialiser with localStorage stubbed (null = unavailable). */
function evalModeInitialiser(store: Record<string, string> | null): string {
	const stub = store === null ? undefined : { getItem: (k: string) => store[k] ?? null };
	return new Function('localStorage', `return (${modeInitialiser()});`)(stub);
}

describe('Editor: read/edit mode defaults to read', () => {
	it('defaults to read when the preference has never been set', () => {
		expect(evalModeInitialiser({})).toBe('read');
	});

	it('defaults to read when localStorage is unavailable (SSR)', () => {
		expect(evalModeInitialiser(null)).toBe('read');
	});

	it('restores edit mode when the writer last chose it', () => {
		expect(evalModeInitialiser({ 'scriptorium-editor-mode': 'edit' })).toBe('edit');
	});

	it('falls back to read on any unrecognised stored value', () => {
		expect(evalModeInitialiser({ 'scriptorium-editor-mode': 'nonsense' })).toBe('read');
	});

	it('uses the same SSR-safe guard as the spellcheck preference', () => {
		expect(modeInitialiser()).toContain("typeof localStorage !== 'undefined'");
	});
});

describe('Editor: mode persistence', () => {
	it('reads and writes the scriptorium-editor-mode key', () => {
		expect(SOURCE).toContain("localStorage.getItem('scriptorium-editor-mode')");
		expect(SOURCE).toContain("localStorage.setItem('scriptorium-editor-mode'");
	});

	it('wraps the write in try/catch so a full quota cannot break the toggle', () => {
		expect(SOURCE).toMatch(/try \{ localStorage\.setItem\('scriptorium-editor-mode'[^}]*\} catch/);
	});

	it('does not reset the mode when the open document changes', () => {
		// Mode is a global preference — the doc-switch path must not touch it.
		const switchFn = SOURCE.match(/async function switchDocument\([\s\S]*?\n\t\}/)?.[0] || '';
		expect(switchFn).toBeTruthy();
		expect(switchFn).not.toMatch(/\bmode\s*=/);
	});
});

describe('Editor: mode drives contenteditable', () => {
	it('constructs the TipTap editor with editable already matching the mode', () => {
		expect(SOURCE).toMatch(/editable:\s*mode === 'edit'/);
	});

	it('calls setEditable with the mode, not a bare boolean', () => {
		expect(SOURCE).toMatch(/setEditable\(mode === 'edit', false\)/);
	});

	it('applies the mode once the editor is constructed on mount', () => {
		const onMountFn = SOURCE.match(/onMount\(\(\) => \{[\s\S]*?\n\t\}\);/)?.[0] || '';
		expect(onMountFn).toBeTruthy();
		expect(onMountFn).toMatch(/setEditable\(mode === 'edit', false\)/);
	});

	it('never lets setEditable emit an update — a mode toggle must not schedule a save', () => {
		// TipTap's setEditable(editable, emitUpdate = true) emits "update" by
		// default. Our onUpdate reads that as the writer typing and schedules a
		// save, so merely switching Read→Edit rewrote the document and bumped
		// updated_at. Verified live in the browser before the fix. Every call
		// site must pass emitUpdate: false.
		const calls = SOURCE.match(/setEditable\([^)]*\)/g) || [];
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toMatch(/,\s*false\)$/);
		}
	});
});

describe('Editor: leaving edit mode flushes pending work', () => {
	const setModeFn = SOURCE.match(/async function setMode\([\s\S]*?\n\t\}/)?.[0] || '';

	it('defines setMode as an async handler', () => {
		expect(setModeFn).toBeTruthy();
		expect(setModeFn).toMatch(/async function setMode\(next: 'read' \| 'edit'\)/);
	});

	it('awaits flushSave when leaving edit mode', () => {
		expect(setModeFn).toMatch(/if \(mode === 'edit'\) await flushSave\(\);/);
	});

	it('flushes before the mode actually changes, so nothing typed is lost', () => {
		const flushAt = setModeFn.indexOf('await flushSave()');
		const assignAt = setModeFn.search(/\bmode = next\b/);
		expect(flushAt).toBeGreaterThan(-1);
		expect(assignAt).toBeGreaterThan(-1);
		expect(flushAt).toBeLessThan(assignAt);
	});
});

describe('Editor: toolbar reflects the mode', () => {
	it('renders a mode toggle with aria-pressed on both buttons', () => {
		const toggle = SOURCE.match(/<div class="mode-toggle">[\s\S]*?<\/div>/)?.[0] || '';
		expect(toggle).toBeTruthy();
		expect(toggle).toMatch(/aria-pressed=\{mode === 'read'\}/);
		expect(toggle).toMatch(/aria-pressed=\{mode === 'edit'\}/);
		expect(toggle).toContain('>Read<');
		expect(toggle).toContain('>Edit<');
	});

	it('hides the formatting controls outside edit mode', () => {
		const gated = SOURCE.match(/\{#if mode === 'edit'\}[\s\S]*?\{\/if\}/)?.[0] || '';
		expect(gated).toBeTruthy();
		for (const control of ['toggleBold', 'toggleItalic', 'toggleHeading', 'toggleBulletList',
			'toggleOrderedList', 'toggleBlockquote', 'undo', 'redo', 'toggleSpellcheck']) {
			expect(gated).toContain(control);
		}
	});

	it('keeps the mode toggle and Copy button visible in both modes', () => {
		const gated = SOURCE.match(/\{#if mode === 'edit'\}[\s\S]*?\{\/if\}/)?.[0] || '';
		expect(gated).not.toContain('mode-toggle');
		expect(gated).not.toContain('copyDocument');
		expect(SOURCE).toMatch(/onclick=\{copyDocument\}/);
	});

	it('hides the spellcheck indicator in read mode, where it means nothing', () => {
		expect(SOURCE).toMatch(/\{#if mode === 'edit'\}\s*<span class="spellcheck-indicator">/);
	});

	it('gives the mode buttons a real touch target on phones', () => {
		const mobileBlock = SOURCE.slice(SOURCE.indexOf('@media (max-width: 768px)'));
		expect(mobileBlock).toMatch(/\.mode-toggle button\s*\{[^}]*min-height:\s*2rem/);
	});
});

describe('Editor: copy the whole document', () => {
	const copyFn = SOURCE.match(/async function copyDocument\([\s\S]*?\n\t\}/)?.[0] || '';

	it('defines the copy handler', () => {
		expect(copyFn).toBeTruthy();
	});

	it('writes both a rich and a plain flavour so formatting survives a paste', () => {
		expect(copyFn).toContain("'text/html'");
		expect(copyFn).toContain("'text/plain'");
		expect(copyFn).toContain('editor.getHTML()');
		expect(copyFn).toMatch(/editor\.getText\(\{ blockSeparator: '\\n\\n' \}\)/);
		expect(copyFn).toMatch(/navigator\.clipboard\.write\(\[\s*new ClipboardItem\(/);
	});

	it('falls back to writeText where ClipboardItem is unavailable', () => {
		expect(copyFn).toMatch(/typeof ClipboardItem !== 'undefined' && navigator\.clipboard\?\.write/);
		expect(copyFn).toContain('navigator.clipboard.writeText(plain)');
	});

	it('never focuses the editor — focus would pop the on-screen keyboard', () => {
		expect(copyFn).not.toMatch(/\.focus\(\)/);
	});

	it('reports success and failure transiently, mirroring the snapshot flash', () => {
		expect(copyFn).toMatch(/try \{[\s\S]*\} catch/);
		expect(SOURCE).toMatch(/let copyFlash[^=]*= \$state\('idle'\)/);
		expect(SOURCE).toContain("'Copied'");
		expect(SOURCE).toContain("'Copy failed'");
		expect(copyFn).toMatch(/setTimeout\(\(\) => \{ copyFlash = 'idle'; \}, 2000\)/);
	});

	it('clears the copy timeout on destroy so it cannot fire after teardown', () => {
		const onDestroyFn = SOURCE.match(/onDestroy\(\(\) => \{[\s\S]*?\n\t\}\);/)?.[0] || '';
		expect(onDestroyFn).toContain('clearTimeout(saveTimeout)');
		expect(onDestroyFn).toContain('clearTimeout(copyTimeout)');
	});
});

describe('help guide + roadmap cover reading mode', () => {
	it('the guide describes Read/Edit and Copy by their real labels', () => {
		const help = fs.readFileSync('src/routes/help/+page.svelte', 'utf-8');
		const writing = help.split('<section id="writing"')[1]?.split('<section id="snapshots"')[0] || '';
		expect(writing).toBeTruthy();
		expect(writing).toMatch(/<em>Read<\/em>/);
		expect(writing).toMatch(/<em>Edit<\/em>/);
		expect(writing).toMatch(/<em>Copy<\/em>/);
		expect(writing).toMatch(/keyboard/i);
	});

	it('the roadmap records the shipped item under a stable key', async () => {
		const { ROADMAP } = await import('../src/lib/roadmap-data.js');
		const item = ROADMAP.find((i) => i.key === 'reading-mode');
		expect(item).toBeTruthy();
		expect(item!.status).toBe('shipped');
		expect(item!.shipped).toBe('2026-07');
	});
});
