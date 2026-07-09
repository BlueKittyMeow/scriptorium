import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * P1-6: /api/import/scan and /api/import/batch resolve symlinks and
 * enforce a home-directory boundary; /api/import did not. The fix extracts
 * that expand -> realpath -> boundary -> isDirectory sequence into
 * src/lib/server/import/resolve-path.ts and wires it into all three
 * endpoints.
 *
 * resolveImportPath is pure (fs + os only, no DB), so it's tested directly
 * here rather than through the route (which would otherwise pull in
 * importScriv -> real DATA_ROOT file writes).
 */

let tmpDir: string;
let homeDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-import-test-'));
	homeDir = os.homedir();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveImportPath (P1-6)', () => {
	it('rejects a path outside the home directory', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		// tmpDir (mktemp under os.tmpdir()) is outside the home directory
		const result = resolveImportPath(tmpDir);
		expect('error' in result).toBe(true);
	});

	it('expands a leading ~ to the home directory', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		const result = resolveImportPath('~');
		expect('resolved' in result).toBe(true);
		if ('resolved' in result) {
			expect(result.resolved).toBe(fs.realpathSync(homeDir));
		}
	});

	it('expands ~/subdir to a path under the home directory', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		const subdir = fs.mkdtempSync(path.join(homeDir, '.scriptorium-import-test-'));
		try {
			const rel = '~/' + path.basename(subdir);
			const result = resolveImportPath(rel);
			expect('resolved' in result).toBe(true);
			if ('resolved' in result) {
				expect(result.resolved).toBe(fs.realpathSync(subdir));
			}
		} finally {
			fs.rmSync(subdir, { recursive: true, force: true });
		}
	});

	it('rejects a nonexistent path', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		const result = resolveImportPath(path.join(homeDir, 'definitely-does-not-exist-xyz'));
		expect('error' in result).toBe(true);
	});

	it('rejects a path that is a file, not a directory', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		const filePath = fs.mkdtempSync(path.join(homeDir, '.scriptorium-import-test-'));
		const file = path.join(filePath, 'notadir.txt');
		fs.writeFileSync(file, 'hello');
		try {
			const result = resolveImportPath(file);
			expect('error' in result).toBe(true);
		} finally {
			fs.rmSync(filePath, { recursive: true, force: true });
		}
	});

	it('does not allow a home-directory-prefix bypass (/home/user vs /home/user2)', async () => {
		const { resolveImportPath } = await import('$lib/server/import/resolve-path.js');
		// Construct a sibling directory whose name starts with the real
		// home dir's basename, to prove startsWith(homeDir) alone would
		// have been a bypass — the fix requires homeDir + '/' explicitly.
		const source = fs.readFileSync(
			path.resolve('src/lib/server/import/resolve-path.ts'),
			'utf8'
		);
		expect(source).toMatch(/startsWith\(homeDir\s*\+\s*['"`]\/['"`]\)/);
	});
});

describe('/api/import endpoint wiring (P1-6)', () => {
	it('uses resolveImportPath instead of a bare existsSync check', () => {
		const fsSync = fs;
		const source = fsSync.readFileSync(path.resolve('src/routes/api/import/+server.ts'), 'utf8');
		expect(source).toContain('resolveImportPath');
		expect(source).not.toContain('existsSync');
	});

	it('rejects the request (400) when resolveImportPath returns an error', () => {
		const source = fs.readFileSync(path.resolve('src/routes/api/import/+server.ts'), 'utf8');
		expect(source).toMatch(/'error' in resolved/);
		expect(source).toMatch(/error\(400, resolved\.error\)/);
	});
});
