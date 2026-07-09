import { describe, it, expect } from 'vitest';

/**
 * RP P0-1 + P2-2 (Workstream W1-1): doc-switch save must target the document the
 * content came from, not the parent's current activeDocId, and HTTP failures must
 * surface so the editor shows an unsaved state instead of a false "Saved".
 *
 * Source-grep style (same as tests/theme-prefs.test.ts): read the source with fs
 * and assert the structural guarantees are present.
 */

const EDITOR = 'src/lib/components/Editor.svelte';
const WORKSPACE = 'src/routes/novels/[id]/+page.svelte';

describe('P0-1: Editor threads the target doc id into every save', () => {
	it('every onsave(...) call passes two arguments (content + docId)', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(EDITOR, 'utf-8');

		// All invocations of the save callback (not the prop type/decl, which use `onsave:`)
		const calls = source.match(/onsave\(editor\.getHTML\(\)[^)]*\)/g) || [];
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// Each call must include a second argument after getHTML()
		for (const call of calls) {
			expect(call).toMatch(/onsave\(editor\.getHTML\(\),\s*\w+\)/);
		}

		// The single-argument form must never appear
		expect(source).not.toContain('onsave(editor.getHTML())');
	});

	it('declares onsave with a docId parameter', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(EDITOR, 'utf-8');
		expect(source).toMatch(/onsave:\s*\(content:\s*string,\s*docId:\s*string\)\s*=>\s*Promise<void>/);
	});

	it('cancels the pending save timer unconditionally at the top of switchDocument', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(EDITOR, 'utf-8');
		const fn = source.slice(source.indexOf('async function switchDocument'));
		const body = fn.slice(0, fn.indexOf('}'));
		// clearTimeout must appear before the conditional unsaved-flush block
		expect(body).toContain('clearTimeout(saveTimeout)');
		expect(body.indexOf('clearTimeout(saveTimeout)')).toBeLessThan(body.indexOf('saveStatus'));
	});
});

describe('P0-1 / P2-2: workspace saveDocument targets its parameter and checks res.ok', () => {
	it('saveDocument declares a docId parameter and uses ${docId} in the fetch URL', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(WORKSPACE, 'utf-8');

		expect(source).toMatch(/async function saveDocument\(content:\s*string,\s*docId:\s*string\)/);
		expect(source).toContain('/api/documents/${docId}');
		// Must not target the mutable activeDocId in the save URL
		expect(source).not.toContain('/api/documents/${activeDocId}`, {');
	});

	it('saveDocument checks res.ok so failed saves throw', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(WORKSPACE, 'utf-8');
		const fn = source.slice(source.indexOf('async function saveDocument'));
		const body = fn.slice(0, fn.indexOf('\n\t}'));
		expect(body).toContain('res.ok');
	});
});

describe('M.2 / M.4: mobile CSS guarantees in the workspace page', () => {
	it('uses 100dvh for the workspace height', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(WORKSPACE, 'utf-8');
		expect(source).toContain('100dvh');
	});

	it('reveals hover-gated row actions at pointer: coarse', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(WORKSPACE, 'utf-8');
		expect(source).toMatch(/@media\s*\(pointer:\s*coarse\)/);
	});
});
