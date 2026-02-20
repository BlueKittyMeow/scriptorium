import { describe, it, expect } from 'vitest';

/**
 * Accessibility findings from code review
 *
 * #6:    Modals lack aria-modal="true" and focus trapping
 * Gemini: Theme toggle needs aria-label for screen readers
 * User:   Binder emoji icons (📁📄) are jarring in dark mode
 */

describe('modal accessibility (#6)', () => {
	it('novel workspace modals should have aria-modal="true"', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

		// Every role="dialog" element should also have aria-modal="true"
		const dialogElements = source.match(/role="dialog"[^>]*/g) || [];
		expect(dialogElements.length).toBeGreaterThan(0);
		for (const el of dialogElements) {
			expect(el).toContain('aria-modal="true"');
		}
	});

	it('library page modals should have aria-modal="true"', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+page.svelte', 'utf-8');

		const dialogElements = source.match(/role="dialog"[^>]*/g) || [];
		expect(dialogElements.length).toBeGreaterThan(0);
		for (const el of dialogElements) {
			expect(el).toContain('aria-modal="true"');
		}
	});
});

describe('theme toggle accessibility (Gemini)', () => {
	it('theme toggle button should have an aria-label', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		// The theme toggle button should have aria-label for screen readers
		// since it only shows an icon (☾/☀/◑)
		const toggleMatch = source.match(/class="theme-toggle"[^>]*/)?.[0] || '';
		expect(toggleMatch).toContain('aria-label');
	});
});

describe('binder icons dark mode (User observation)', () => {
	it('binder tree should not use emoji icons for folders and documents', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/novels/[id]/+page.svelte', 'utf-8');

		// Check only the template section (before <style>), not comments
		const templateSection = source.split('<style>')[0];

		// 📁 and 📄 are jarring in dark mode; should be replaced with
		// CSS-styled text or SVG icons that respond to the theme
		expect(templateSection).not.toContain('📁');
		expect(templateSection).not.toContain('📄');
	});
});
