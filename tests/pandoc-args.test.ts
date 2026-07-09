import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * P1-10 part 3: pandoc's docx/epub writers emit their own title block when
 * given --standalone plus --metadata=title/subtitle, stacking a duplicate
 * title page on top of assembleCompileHtml's generated one.
 *
 * Fix: per-format metadata policy in buildPandocArgs.
 *   - epub: keep --metadata=title (and subtitle when present) since the OPF
 *     package requires a <dc:title>.
 *   - docx / markdown / pdf: do NOT pass --metadata title/subtitle; the
 *     assembled HTML already carries the generated title page.
 */

describe('P1-10 part 3: buildPandocArgs per-format metadata policy', () => {
	it('exports buildPandocArgs for direct testing', async () => {
		const mod = await import('$lib/server/compile/pandoc.js');
		expect(typeof mod.buildPandocArgs).toBe('function');
	});

	it('epub args include --metadata=title', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		const args = buildPandocArgs('epub', { title: 'My Novel', subtitle: null });
		expect(args.some((a) => a.startsWith('--metadata=title:'))).toBe(true);
	});

	it('epub args include --metadata=subtitle when a subtitle is present', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		const args = buildPandocArgs('epub', { title: 'My Novel', subtitle: 'A Subtitle' });
		expect(args.some((a) => a.startsWith('--metadata=subtitle:'))).toBe(true);
	});

	it('docx args do NOT include --metadata=title or subtitle', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		const args = buildPandocArgs('docx', { title: 'My Novel', subtitle: 'A Subtitle' });
		expect(args.some((a) => a.startsWith('--metadata=title:'))).toBe(false);
		expect(args.some((a) => a.startsWith('--metadata=subtitle:'))).toBe(false);
	});

	it('markdown args do NOT include --metadata=title or subtitle', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		const args = buildPandocArgs('markdown', { title: 'My Novel', subtitle: 'A Subtitle' });
		expect(args.some((a) => a.startsWith('--metadata=title:'))).toBe(false);
		expect(args.some((a) => a.startsWith('--metadata=subtitle:'))).toBe(false);
	});

	it('pdf args do NOT include --metadata=title or subtitle, but keep the pdf engine', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		const args = buildPandocArgs('pdf', { title: 'My Novel', subtitle: 'A Subtitle' });
		expect(args.some((a) => a.startsWith('--metadata=title:'))).toBe(false);
		expect(args.some((a) => a.startsWith('--metadata=subtitle:'))).toBe(false);
		expect(args).toContain('--pdf-engine=wkhtmltopdf');
	});

	it('all formats still pass --standalone', async () => {
		const { buildPandocArgs } = await import('$lib/server/compile/pandoc.js');
		for (const format of ['docx', 'epub', 'pdf', 'markdown'] as const) {
			const args = buildPandocArgs(format, { title: 'T', subtitle: null });
			expect(args).toContain('--standalone');
		}
	});
});

describe('P2-8: pandoc stdin error guard', () => {
	it('spawnPandoc attaches an error handler to proc.stdin', () => {
		const source = fs.readFileSync('src/lib/server/compile/pandoc.ts', 'utf-8');
		expect(source).toMatch(/proc\.stdin\.on\(\s*['"]error['"]/);
	});
});

describe('P1-10 part 3: assemble.ts title-page option', () => {
	it('assembleCompileHtml accepts an optional options parameter and stays backward-compatible', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		// Backward-compatible call (no options arg) still works
		const result = assembleCompileHtml([], { title: 'Novel', subtitle: null }, () => '');
		expect(result.html).toContain('Novel');
	});

	it('omits the generated title-page div when includeTitlePage is false', async () => {
		const { assembleCompileHtml } = await import('$lib/server/compile/assemble.js');
		const withTitlePage = assembleCompileHtml([], { title: 'Novel', subtitle: null }, () => '', {
			includeTitlePage: true
		});
		const withoutTitlePage = assembleCompileHtml([], { title: 'Novel', subtitle: null }, () => '', {
			includeTitlePage: false
		});
		expect(withTitlePage.html).toContain('<div class="title-page">');
		expect(withoutTitlePage.html).not.toContain('<div class="title-page">');
	});
});
