import { describe, it, expect } from 'vitest';

/**
 * Mobile layout fixes (real-device screenshots at 591px width)
 *
 * Verify:
 * 1. Top bar becomes a normal-flow, full-width bar at <=768px (no longer
 *    floats over page content) while desktop keeps the floating look.
 * 2. Admin page tables scroll within their own box instead of forcing
 *    page-level horizontal scroll.
 * 3. Admin page form inputs/selects use a >=16px font-size on mobile so
 *    focusing them doesn't trigger iOS/Android auto-zoom.
 */

function extractMobileMediaBlocks(source: string): string[] {
	const blocks: string[] = [];
	const re = /@media\s*\(max-width:\s*768px\)\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(source))) {
		// Walk forward from the opening brace to find its matching closing brace.
		let depth = 1;
		let i = match.index + match[0].length;
		const start = i;
		while (depth > 0 && i < source.length) {
			if (source[i] === '{') depth++;
			else if (source[i] === '}') depth--;
			i++;
		}
		blocks.push(source.slice(start, i - 1));
	}
	return blocks;
}

describe('top bar: mobile normal-flow layout', () => {
	it('should keep the floating (fixed) top bar as the desktop default', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		// Desktop default, outside any media query, must still float.
		const beforeMedia = source.split('@media')[0];
		expect(beforeMedia).toContain('.top-bar');
		expect(beforeMedia).toMatch(/\.top-bar\s*\{[^}]*position:\s*fixed/);
	});

	it('should have a <=768px media query making the top bar static/full-width', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		const blocks = extractMobileMediaBlocks(source);
		expect(blocks.length).toBeGreaterThan(0);

		const topBarBlock = blocks.find((b) => b.includes('.top-bar'));
		expect(topBarBlock).toBeTruthy();
		expect(topBarBlock).toMatch(/\.top-bar\s*\{[^}]*position:\s*static/);
		expect(topBarBlock).toMatch(/\.top-bar\s*\{[^}]*width:\s*100%/);
	});

	it('should render the top bar before page content in markup so static flow puts it at the top', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		const topBarPos = source.indexOf('class="top-bar"');
		const appPos = source.indexOf('class="app"');
		expect(topBarPos).toBeGreaterThan(-1);
		expect(appPos).toBeGreaterThan(-1);
		expect(topBarPos).toBeLessThan(appPos);
	});
});

describe('admin page: tables scroll instead of the whole page', () => {
	it('should wrap data tables in a container with overflow-x: auto', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/admin/+page.svelte', 'utf-8');

		expect(source).toContain('overflow-x: auto');
		// Every data-table in the markup should be inside a table-scroll wrapper.
		expect(source).toContain('table-scroll');
		const tableCount = (source.match(/<table class="data-table">/g) || []).length;
		const wrapperCount = (source.match(/<div class="table-scroll">/g) || []).length;
		expect(tableCount).toBeGreaterThan(0);
		expect(wrapperCount).toBe(tableCount);
	});

	it('should not set a fixed min-width on the page container that would force horizontal scroll', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/admin/+page.svelte', 'utf-8');

		const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
		expect(styleMatch).toBeTruthy();
		const styleBlock = styleMatch![1];
		const adminPageRule = styleBlock.match(/\.admin-page\s*\{[^}]*\}/g) || [];
		for (const rule of adminPageRule) {
			expect(rule).not.toMatch(/min-width:\s*(?!0)/);
		}
	});
});

describe('admin page: mobile input font-size prevents auto-zoom', () => {
	it('should set input/select font-size to >=16px inside a <=768px media query', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/admin/+page.svelte', 'utf-8');

		const blocks = extractMobileMediaBlocks(source);
		expect(blocks.length).toBeGreaterThan(0);

		const fontBlock = blocks.find((b) => /font-size:\s*16px/.test(b));
		expect(fontBlock).toBeTruthy();
		expect(fontBlock).toMatch(/input[\s\S]*?font-size:\s*16px/);
	});
});
