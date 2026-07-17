import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * Doc-title rename (pencil button in the editor header) + the mobile
 * hamburger gutter it depends on.
 *
 * Source-grep style, matching tests/editor-save.test.ts and
 * tests/mobile-layout.test.ts: these assert the wiring exists rather than
 * mounting the Svelte component (no request-level harness for this UI).
 */

describe('Editor: exposes an onrename prop', () => {
	const SOURCE = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

	it('declares onrename as an optional prop', () => {
		expect(SOURCE).toMatch(/onrename\s*\?\s*:\s*\(title:\s*string\)\s*=>\s*void/);
	});

	it('only renders the pencil button when onrename is provided', () => {
		expect(SOURCE).toMatch(/\{#if onrename\}[\s\S]*?rename-btn[\s\S]*?\{\/if\}/);
	});

	it('calls onrename with the trimmed title on commit, not before', () => {
		expect(SOURCE).toMatch(/onrename\?\.\(trimmed\)/);
	});

	it('does not optimistically assign the local draft back onto the title prop', () => {
		// The commit handler should never do `title = ...` — the prop flows
		// back down from the parent once the rename request completes.
		const commitFn = SOURCE.match(/function commitTitleRename\(\)\s*\{[\s\S]*?\n\t\}/)?.[0] || '';
		expect(commitFn).toBeTruthy();
		expect(commitFn).not.toMatch(/\btitle\s*=\s*[^=]/);
	});
});

describe('workspace: wires Editor onrename to renameNode', () => {
	const SOURCE = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

	it('passes an onrename callback to the Editor component', () => {
		const editorBlock = SOURCE.match(/<Editor[\s\S]*?\/>/)?.[0] || '';
		expect(editorBlock).toContain('onrename=');
	});

	it('resolves the active doc node via findNodeById before calling renameNode', () => {
		const editorBlock = SOURCE.match(/<Editor[\s\S]*?\/>/)?.[0] || '';
		expect(editorBlock).toMatch(/findNodeById\(tree,\s*activeDocId\)/);
		expect(editorBlock).toMatch(/renameNode\(node,\s*t\)/);
	});

	it('defines a shared renameNode(node, newTitle) function used by both the binder and the editor header', () => {
		expect(SOURCE).toMatch(/async function renameNode\(node:\s*TreeNode,\s*newTitle:\s*string\)/);
	});
});

describe('Editor: mobile gutter clears the fixed hamburger button', () => {
	const SOURCE = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

	it('keeps the title row in normal flow (no gutter) outside the mobile media query', () => {
		const beforeMedia = SOURCE.split('@media')[0];
		expect(beforeMedia).toContain('.title-row');
	});

	it('adds left padding to the title row within the <=768px media query to clear .binder-reopen', () => {
		const mediaBlockStart = SOURCE.indexOf('@media (max-width: 768px)');
		expect(mediaBlockStart).toBeGreaterThan(-1);
		const mobileBlock = SOURCE.slice(mediaBlockStart);
		expect(mobileBlock).toMatch(/\.title-row\s*\{[^}]*padding:\s*0\.5rem 1rem 0 3\.5rem/);
	});
});
