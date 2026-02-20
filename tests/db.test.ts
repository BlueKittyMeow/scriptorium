import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * Bug: Missing busy_timeout pragma in db.ts
 *
 * better-sqlite3 defaults to 0ms busy timeout, so any concurrent writer
 * immediately gets SQLITE_BUSY. With WAL mode and autosave, this is likely.
 *
 * We test this by reading the db.ts source and verifying the pragma is set,
 * since we can't easily import getDb() (it depends on $env/dynamic/private).
 */
describe('database configuration', () => {
	it('should set busy_timeout pragma', async () => {
		const fs = await import('fs');
		const source = fs.readFileSync('src/lib/server/db.ts', 'utf-8');
		expect(source).toContain('busy_timeout');
	});
});
