import { describe, it, expect } from 'vitest';

/**
 * Robustness findings from code review
 *
 * #1:     DB init has no try/catch — schema failure crashes app
 * #3:     Atomic write doesn't fsync parent directory after rename
 * #10:    Concurrent snapshot duplicate — stale last_snapshot_at check
 * Gemini: localStorage.setItem not wrapped in try/catch
 */

describe('DB initialization error handling (#1)', () => {
	it('getDb should wrap initialization in try/catch', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');

		// The init sequence (mkdirSync, new Database, exec) should be in a try/catch
		// so that a bad DATA_ROOT or schema error produces a clear error, not an unhandled crash
		expect(source).toMatch(/try\s*\{[\s\S]*?new Database[\s\S]*?\}\s*catch/);
	});
});

describe('atomic write parent directory fsync (#3)', () => {
	it('writeFileAtomic should fsync parent directory after rename', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/files.ts', 'utf-8');

		// Extract the writeFileAtomic function body
		const fnMatch = source.match(/function writeFileAtomic[\s\S]*?^}/m);
		const fnBody = fnMatch?.[0] || '';

		// After renameSync, there should be an fsyncSync of the parent directory
		// to ensure the rename is durable after a crash
		expect(fnBody).toMatch(/renameSync[\s\S]*?fsyncSync/);
	});
});

describe('concurrent snapshot prevention (#10)', () => {
	it('should read last_snapshot_at fresh inside the transaction', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/api/documents/[id]/+server.ts', 'utf-8');

		// The snapshot timing check currently uses doc.last_snapshot_at which is
		// fetched before the transaction begins (stale read).
		// Fix: re-SELECT last_snapshot_at inside the transaction.
		const txnBlock = source.match(/transaction\(\(\) => \{[\s\S]*?\}\)/)?.[0] || '';
		expect(txnBlock).toMatch(/SELECT[\s\S]*?last_snapshot_at[\s\S]*?FROM documents/i);
	});
});

describe('localStorage error handling (Gemini)', () => {
	it('Editor.svelte should wrap localStorage.setItem in try/catch', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/components/Editor.svelte', 'utf-8');

		// Every localStorage.setItem call should be wrapped in try/catch
		// to handle QuotaExceededError in constrained environments
		const setItemCalls = source.match(/localStorage\.setItem/g) || [];
		expect(setItemCalls.length).toBeGreaterThan(0);

		const tryCatchAroundSetItem = source.match(/try\s*\{[^}]*localStorage\.setItem/g) || [];
		expect(tryCatchAroundSetItem.length).toBe(setItemCalls.length);
	});

	it('+layout.svelte should wrap localStorage.setItem in try/catch', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/routes/+layout.svelte', 'utf-8');

		const setItemCalls = source.match(/localStorage\.setItem/g) || [];
		expect(setItemCalls.length).toBeGreaterThan(0);

		const tryCatchAroundSetItem = source.match(/try\s*\{[^}]*localStorage\.setItem/g) || [];
		expect(tryCatchAroundSetItem.length).toBe(setItemCalls.length);
	});
});
