import { describe, it, expect } from 'vitest';

/**
 * Bug: Fire-and-forget save on editor destroy/switch
 *
 * The onDestroy and doc-switch $effect call onsave() without await.
 * We verify:
 * 1. The doc-switch flow awaits the save before loading new content
 * 2. onDestroy uses a reliable mechanism (keepalive fetch) for final save
 */
describe('editor save reliability', () => {
	it('should await save in doc-switch handler before loading new content', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		// The switchDocument function (called from the doc-switch effect)
		// should await the onsave call before setting new content
		expect(source).toMatch(/async\s+function\s+switchDocument/);
		expect(source).toMatch(/await\s+onsave/);
	});

	it('should use keepalive fetch for onDestroy save', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		// The onDestroy should use fetch with keepalive: true
		// to ensure the save completes even during page unload
		expect(source).toContain('keepalive');
	});
});
