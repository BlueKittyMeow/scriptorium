import { describe, it, expect } from 'vitest';

/**
 * Phase 2: Dark mode + persistent preferences
 *
 * Verify:
 * 1. CSS custom properties defined (no hardcoded colors in style blocks)
 * 2. Dark theme variables exist
 * 3. Flash-prevention script in app.html
 * 4. Theme toggle in layout
 * 5. Spellcheck persistence via localStorage
 */
describe('CSS custom properties', () => {
	it('should define light theme variables on :root', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		expect(source).toContain('--bg:');
		expect(source).toContain('--text:');
		expect(source).toContain('--accent:');
		expect(source).toContain('--border:');
		expect(source).toContain('--saved:');
	});

	it('should define dark theme variables', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		expect(source).toContain('data-theme="dark"');
		// Dark theme should have different bg value than light
		const darkSection = source.split('data-theme="dark"')[1];
		expect(darkSection).toContain('--bg:');
		expect(darkSection).toContain('--text:');
	});

	it('should not have hardcoded color hex values in page style blocks', async () => {
		const fs = await import('fs');

		const files = [
			'src/routes/+page.svelte',
			'src/routes/novels/[id]/+page.svelte',
			'src/lib/components/Editor.svelte'
		];

		for (const file of files) {
			const source = fs.readFileSync(file, 'utf-8');
			// Extract just the <style> block
			const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
			if (!styleMatch) continue;
			const styleBlock = styleMatch[1];

			// Should not contain bare hex color values (but var() references are fine)
			// Match hex colors like #fff, #ffffff, #faf9f7 that aren't inside var()
			const hexColors = styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
			expect(hexColors).toHaveLength(0);
		}
	});

	it('should use var() references in component styles', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		expect(source).toContain('var(--text-heading)');
		expect(source).toContain('var(--bg-surface)');
		expect(source).toContain('var(--bg-elevated)');
		expect(source).toContain('var(--saved)');
	});
});

describe('flash-prevention script', () => {
	it('should have inline theme script in app.html before sveltekit.head', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/app.html', 'utf-8');

		// Script must set data-theme before CSS loads
		expect(source).toContain('scriptorium-theme');
		expect(source).toContain('data-theme');

		// Script should appear before %sveltekit.head%
		const scriptPos = source.indexOf('scriptorium-theme');
		const headPos = source.indexOf('%sveltekit.head%');
		expect(scriptPos).toBeLessThan(headPos);
	});
});

describe('theme toggle', () => {
	it('should have theme cycling logic in layout', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		expect(source).toContain('cycleTheme');
		expect(source).toContain('theme-toggle');
		// Should support system/light/dark cycle
		expect(source).toMatch(/['"]system['"]/);
		expect(source).toMatch(/['"]light['"]/);
		expect(source).toMatch(/['"]dark['"]/);
	});
});

describe('spellcheck persistence', () => {
	it('should read spellcheck preference from localStorage', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		expect(source).toContain('scriptorium-spellcheck');
		// Should read on init
		expect(source).toContain("localStorage.getItem('scriptorium-spellcheck')");
	});

	it('should write spellcheck preference to localStorage on toggle', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		expect(source).toContain("localStorage.setItem('scriptorium-spellcheck'");
	});
});
