import { describe, it, expect } from 'vitest';

/**
 * In-app user guide (/help)
 *
 * Verify:
 * 1. The /help route exists as a static page (no server load needed — the
 *    layout guard already handles auth).
 * 2. The guide covers the key feature areas: library, writing/autosave,
 *    snapshots + compare, search, importing (scriv + bundle dry-run),
 *    compiling, trash/recovery, and the archivist-only section.
 * 3. The top bar links to /help with a consistent, themed control.
 * 4. Content stays honest: concrete UI affordances the guide references
 *    (⇄ compare icon, Dry Run button, restore confirm) actually exist.
 */

const HELP_PATH = 'src/routes/help/+page.svelte';
const LAYOUT_PATH = 'src/routes/+layout.svelte';

describe('help route: page exists with table of contents', () => {
	it('should have a /help page component', async () => {
		const fs = await import('fs');
		expect(fs.existsSync(HELP_PATH)).toBe(true);
	});

	it('should have an in-page table of contents linking to section anchors', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toMatch(/<nav class="toc"/);
		// TOC links must point at sections that exist
		const tocLinks = [...source.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
		expect(tocLinks.length).toBeGreaterThanOrEqual(8);
		for (const anchor of tocLinks) {
			expect(source).toContain(`<section id="${anchor}"`);
		}
	});

	it('should not need a +page.server.ts (the guide itself is still static; the Requests & Questions and Roadmap tabs fetch client-side)', async () => {
		const fs = await import('fs');
		expect(fs.existsSync('src/routes/help/+page.server.ts')).toBe(false);
	});
});

describe('help guide: covers the key sections', () => {
	it('should document the library, writing, snapshots, search, importing, compiling, and trash', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		for (const id of ['library', 'shelves', 'writing', 'snapshots', 'search', 'importing', 'compiling', 'trash', 'tips', 'archivists']) {
			expect(source).toContain(`<section id="${id}"`);
		}
	});

	it('should describe shelves, eras, version stacks, moving, and managing shelves', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		const shelvesSection = source.split('<section id="shelves"')[1]?.split('<section id="writing"')[0];
		expect(shelvesSection).toBeTruthy();
		expect(shelvesSection).toMatch(/universe/i);
		expect(shelvesSection).toMatch(/era/i);
		expect(shelvesSection).toMatch(/versions/i);
		expect(shelvesSection).toContain('Move to…');
		expect(shelvesSection).toContain('Edit shelves');
		expect(shelvesSection).toContain('Unsorted');
		expect(shelvesSection).toContain('▸');
		expect(shelvesSection).toContain('▾');
	});

	it('should describe autosave and the save status indicator', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toMatch(/[Aa]utosave/);
		expect(source).toContain('Saved');
		expect(source).toContain('Unsaved changes');
	});

	it('should describe the spellcheck toggle and theme cycle', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toMatch(/spellcheck/i);
		expect(source).toContain('ABC');
		// theme cycle: system → light → dark
		expect(source).toMatch(/system/i);
	});

	it('should describe the ABC button working by tap on phones, consistent with the toolbar wrapping', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');
		const editor = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		const spellcheckPara = source.split('<h3>Spellcheck</h3>')[1]?.split('</p>')[0] || '';
		expect(spellcheckPara).toMatch(/phone/i);
		expect(spellcheckPara).toMatch(/tap/i);
		expect(spellcheckPara).toMatch(/wraps/i);
		// The claim is only honest if the toolbar actually wraps and the ABC button is a plain tappable button.
		expect(editor).toMatch(/flex-wrap:\s*wrap/);
		expect(editor).toMatch(/class="tb-btn"[^>]*onclick={toggleSpellcheck}[^>]*>ABC</);
	});

	it('should describe snapshot compare with the actual ⇄ icon and green/red diff colors', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toContain('⇄');
		expect(source).toMatch(/green/i);
		expect(source).toMatch(/red/i);
		// Imported variants labelled with their source filename
		expect(source).toMatch(/source filename/i);
		// Restore is confirmed and preserves the current text as a snapshot
		expect(source).toMatch(/pre-restore/);
		expect(source).toMatch(/confirm/i);
	});

	it('should describe search prefix matching and Ctrl+K', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toContain('Ctrl+K');
		expect(source).toMatch(/word beginnings|prefix/i);
	});

	it('should describe scriv single + batch import and the bundle dry-run flow', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toContain('.scriv');
		expect(source).toContain('Scan for Projects');
		expect(source).toContain('Dry Run');
		// Archivist owner picker mentioned
		expect(source).toMatch(/Owner.*picker|picker.*Owner/i);
	});

	it('should list the compile formats the dialog actually offers', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toContain('.docx');
		expect(source).toContain('EPUB');
		expect(source).toContain('PDF');
		expect(source).toContain('Markdown');
	});

	it('should present trash as soft delete with restore (preservation-first)', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		expect(source).toMatch(/preservation-first/i);
		expect(source).toMatch(/never silently destroyed|nothing is ever silently destroyed/i);
		expect(source).toContain('↩');
	});

	it('should mark archivist-only features as a clearly separate section', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(HELP_PATH, 'utf-8');

		const archivistSection = source.split('<section id="archivists"')[1];
		expect(archivistSection).toBeTruthy();
		expect(archivistSection).toMatch(/Admin/);
		expect(archivistSection).toMatch(/Owner/);
	});
});

describe('help guide: honesty checks against the real UI', () => {
	it('the ⇄ compare control the guide references exists in the snapshot panel', async () => {
		const fs = await import('fs');
		const panel = fs.readFileSync('src/lib/components/SnapshotPanel.svelte', 'utf-8');
		expect(panel).toContain('⇄');
		expect(panel).toMatch(/Compare with current/);
	});

	it('the Dry Run button the guide references exists in the import modal', async () => {
		const fs = await import('fs');
		const library = fs.readFileSync('src/routes/+page.svelte', 'utf-8');
		expect(library).toContain('Dry Run');
	});

	it('the restore confirm dialog the guide references exists in the workspace', async () => {
		const fs = await import('fs');
		const workspace = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');
		expect(workspace).toContain('Restore to this version?');
		expect(workspace).toMatch(/saved as a snapshot before restoring/);
	});

	it('the compile formats listed in the guide match the dialog options', async () => {
		const fs = await import('fs');
		const dialog = fs.readFileSync('src/lib/components/CompileDialog.svelte', 'utf-8');
		for (const fmt of ['docx', 'epub', 'pdf', 'markdown']) {
			expect(dialog).toContain(`value="${fmt}"`);
		}
	});
});

	it('the shelf move/stack/manage controls the guide references exist in the library page', async () => {
		const fs = await import('fs');
		const library = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

		// Card ⋯ menu → Move to… / Stack… / Clear stack
		expect(library).toContain('Move to…');
		expect(library).toContain('Stack…');
		expect(library).toContain('Clear stack');
		expect(library).toMatch(/title="Move to shelf or set version stack"/);
		// Edit shelves affordance + manage modal reorder/delete
		expect(library).toContain('Edit shelves');
		expect(library).toMatch(/Move up/);
		expect(library).toMatch(/Move down/);
		expect(library).toMatch(/will fall to Unsorted/);
		expect(library).toMatch(/will promote to top-level/);
		// Chevrons and the collapse-state localStorage key
		expect(library).toContain('▸');
		expect(library).toContain('▾');
		expect(library).toContain('scriptorium-collections-collapsed');
		// Drag-and-drop onto shelf headers + version-stack "N versions" chip
		expect(library).toMatch(/ondragstart=/);
		expect(library).toMatch(/ondrop=/);
		expect(library).toMatch(/versions/);
	});

	it('the Move-to/Stack menu button stays visible without hover on touch devices, matching the guide\'s phone claim', async () => {
		const fs = await import('fs');
		const library = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

		expect(library).toMatch(/@media \(pointer: coarse\)/);
		const touchBlock = library.split('@media (pointer: coarse)')[1]?.split('}\n\n')[0] || '';
		expect(touchBlock).toMatch(/\.menu-btn/);
	});

describe('top bar: help link', () => {
	it('should link to /help from the top bar', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(LAYOUT_PATH, 'utf-8');

		expect(source).toMatch(/<a href="\/help" class="help-link"/);
	});

	it('should have an accessible label and title', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(LAYOUT_PATH, 'utf-8');

		const linkMatch = source.match(/<a href="\/help"[^>]*/)?.[0] || '';
		expect(linkMatch).toContain('aria-label');
		expect(linkMatch).toContain('title');
	});

	it('should style the help link with CSS variables only (theme-safe)', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync(LAYOUT_PATH, 'utf-8');

		const styleBlock = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] || '';
		// .help-link shares the theme-toggle's themed styling
		expect(styleBlock).toContain('.help-link');
		const helpRules = styleBlock.match(/[^}]*\.help-link[^{]*\{[^}]*\}/g) || [];
		expect(helpRules.length).toBeGreaterThan(0);
		for (const rule of helpRules) {
			const body = rule.slice(rule.indexOf('{'));
			const hexColors = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
			expect(hexColors).toHaveLength(0);
		}
	});
});
