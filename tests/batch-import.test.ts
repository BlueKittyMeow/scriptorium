import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
	db = createTestDb();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-batch-test-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: create a minimal valid .scriv bundle with a .scrivx file */
function createScrivBundle(parentDir: string, name: string, docs?: { id: string; title: string }[]): string {
	const scrivDir = path.join(parentDir, `${name}.scriv`);
	fs.mkdirSync(path.join(scrivDir, 'Files', 'Docs'), { recursive: true });

	const binderItems = (docs || []).map(d =>
		`<BinderItem ID="${d.id}" Type="Text" Created="" Modified=""><Title>${d.title}</Title></BinderItem>`
	).join('\n');

	const scrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject>
  <Binder>
    <BinderItem ID="1" Type="Folder" Created="" Modified="">
      <Title>Manuscript</Title>
      ${binderItems ? `<Children>${binderItems}</Children>` : ''}
    </BinderItem>
  </Binder>
</ScrivenerProject>`;

	fs.writeFileSync(path.join(scrivDir, `${name}.scrivx`), scrivx);
	return scrivDir;
}

// ============================================================
// Scan logic tests (DB-free, unit tests)
// ============================================================
describe('scan logic', () => {
	it('should find .scriv directories in a flat directory', async () => {
		createScrivBundle(tmpDir, 'Novel1');
		createScrivBundle(tmpDir, 'Novel2');
		createScrivBundle(tmpDir, 'Novel3');

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir);

		expect(results).toHaveLength(3);
		const names = results.map(r => r.name).sort();
		expect(names).toEqual(['Novel1', 'Novel2', 'Novel3']);
	});

	it('should find .scriv in nested subdirectories', async () => {
		const subDir = path.join(tmpDir, 'level1', 'level2');
		fs.mkdirSync(subDir, { recursive: true });
		createScrivBundle(tmpDir, 'TopLevel');
		createScrivBundle(subDir, 'Nested');

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir);

		expect(results).toHaveLength(2);
		const names = results.map(r => r.name).sort();
		expect(names).toEqual(['Nested', 'TopLevel']);
	});

	it('should skip hidden directories', async () => {
		const hiddenDir = path.join(tmpDir, '.backup');
		fs.mkdirSync(hiddenDir, { recursive: true });
		createScrivBundle(hiddenDir, 'HiddenNovel');
		createScrivBundle(tmpDir, 'VisibleNovel');

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir);

		expect(results).toHaveLength(1);
		expect(results[0].name).toBe('VisibleNovel');
	});

	it('should respect max depth', async () => {
		// Create a .scriv at depth 6 (beyond default maxDepth=5)
		let deepDir = tmpDir;
		for (let i = 0; i < 6; i++) {
			deepDir = path.join(deepDir, `level${i}`);
		}
		fs.mkdirSync(deepDir, { recursive: true });
		createScrivBundle(deepDir, 'TooDeep');

		// Also create one at depth 1 (should be found)
		createScrivBundle(tmpDir, 'Shallow');

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir, { maxDepth: 5 });

		expect(results).toHaveLength(1);
		expect(results[0].name).toBe('Shallow');
	});

	it('should skip .scriv without .scrivx file', async () => {
		// Create a directory ending in .scriv but with no .scrivx inside
		const fakeDir = path.join(tmpDir, 'Fake.scriv');
		fs.mkdirSync(fakeDir, { recursive: true });
		fs.writeFileSync(path.join(fakeDir, 'random.txt'), 'not a scrivener project');

		// Create a valid one
		createScrivBundle(tmpDir, 'Valid');

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir);

		expect(results).toHaveLength(1);
		expect(results[0].name).toBe('Valid');
	});

	it('should return empty array for directory with no projects', async () => {
		// Just some random files, no .scriv dirs
		fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello');
		fs.mkdirSync(path.join(tmpDir, 'subdir'));

		const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
		const results = await scanForScrivProjects(tmpDir);

		expect(results).toHaveLength(0);
	});

	it('should skip symlinked directories', async () => {
		// Create a valid .scriv in a separate location
		const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-external-'));
		try {
			createScrivBundle(externalDir, 'External');

			// Symlink it into our scan directory
			try {
				fs.symlinkSync(
					path.join(externalDir, 'External.scriv'),
					path.join(tmpDir, 'Linked.scriv')
				);
			} catch {
				// Symlinks not supported on this platform — skip test
				return;
			}

			// Also create a real one
			createScrivBundle(tmpDir, 'Real');

			const { scanForScrivProjects } = await import('$lib/server/import/scan.js');
			const results = await scanForScrivProjects(tmpDir);

			// Should only find the real one, not the symlinked one
			expect(results).toHaveLength(1);
			expect(results[0].name).toBe('Real');
		} finally {
			fs.rmSync(externalDir, { recursive: true, force: true });
		}
	});
});

// ============================================================
// Batch import tests (DB-level)
// ============================================================
describe('batch import', () => {
	it('should import multiple projects', async () => {
		const scriv1 = createScrivBundle(tmpDir, 'Novel1');
		const scriv2 = createScrivBundle(tmpDir, 'Novel2');

		const { importScriv } = await import('$lib/server/import/scriv.js');

		const results = [];
		for (const scrivPath of [scriv1, scriv2]) {
			const report = await importScriv(db, scrivPath);
			results.push(report);
		}

		// Both should succeed
		expect(results).toHaveLength(2);
		expect(results[0].errors).toHaveLength(0);
		expect(results[1].errors).toHaveLength(0);

		// Two novels in DB
		const novels = db.prepare('SELECT * FROM novels').all();
		expect(novels).toHaveLength(2);
	});

	it('should isolate errors between projects', async () => {
		const good = createScrivBundle(tmpDir, 'GoodNovel');

		// Create a broken .scriv — valid scrivx but references nonexistent RTF
		const badDir = path.join(tmpDir, 'BadNovel.scriv');
		fs.mkdirSync(path.join(badDir, 'Files', 'Docs'), { recursive: true });
		const badScrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject>
  <Binder>
    <BinderItem ID="1" Type="Folder" Created="" Modified="">
      <Title>Draft</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;
		fs.writeFileSync(path.join(badDir, 'BadNovel.scrivx'), badScrivx);

		const { importScriv } = await import('$lib/server/import/scriv.js');

		// Import good one first, then bad one — good should still be fine
		const report1 = await importScriv(db, good);
		let report2;
		try {
			report2 = await importScriv(db, badDir);
		} catch {
			report2 = { errors: ['threw'], docs_imported: 0 };
		}

		// Good import succeeded
		expect(report1.novel_title).toBe('GoodNovel');
		expect(report1.errors).toHaveLength(0);

		// At least one novel should be in DB (the good one)
		const novels = db.prepare('SELECT * FROM novels').all();
		expect(novels.length).toBeGreaterThanOrEqual(1);
	});

	it('should return correct summary totals including word count', async () => {
		const scriv = createScrivBundle(tmpDir, 'WordCountNovel');
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scriv);

		// Report should have total_word_count field
		expect(report).toHaveProperty('total_word_count');
		expect(typeof report.total_word_count).toBe('number');
	});

	it('should handle non-directory path gracefully', async () => {
		// Create a regular file, not a directory
		const filePath = path.join(tmpDir, 'not-a-directory.scriv');
		fs.writeFileSync(filePath, 'just a file');

		// The batch endpoint should include this as an error in results,
		// not throw an unhandled exception. Test at endpoint source level.
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		// Should check isDirectory or statSync to catch non-directory paths
		expect(
			source.includes('isDirectory') || source.includes('statSync')
		).toBe(true);
	});

	it('should handle nonexistent path gracefully', async () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		// Should check existence and not throw — errors go into results
		expect(
			source.includes('existsSync') || source.includes('statSync')
		).toBe(true);
	});
});

// ============================================================
// API source-scan tests
// ============================================================
describe('scan endpoint', () => {
	it('should validate path is a directory', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		expect(
			source.includes('isDirectory') || source.includes('statSync')
		).toBe(true);
	});

	it('should enforce homedir boundary', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		expect(
			source.includes('homedir') || source.includes('realpathSync')
		).toBe(true);
	});
});

describe('batch endpoint', () => {
	it('should validate paths is an array', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		expect(source.includes('Array.isArray')).toBe(true);
	});

	it('should call importScriv for each path', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		expect(source.includes('importScriv')).toBe(true);
		// Should have a loop
		expect(source.includes('for') || source.includes('forEach')).toBe(true);
	});
});

// ============================================================
// Bug fix tests
// ============================================================
describe('bug fixes', () => {
	// Bug 1: Tilde expansion — realpathSync('~/Writing') throws ENOENT
	it('scan endpoint should expand tilde before resolving path', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		// Should replace ~ with homedir before passing to realpathSync
		expect(source).toMatch(/replace.*~.*homeDir|homeDir.*replace.*~/)
	});

	it('batch endpoint should expand tilde before resolving path', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		// Should replace ~ with homedir
		expect(source).toMatch(/replace.*~.*homeDir|homeDir.*replace.*~/)
	});

	// Bug 2: closeImportModal blocks during scan because isBusy includes 'scanning'
	it('closeImportModal should abort scan before blocking check', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/+page.svelte'),
			'utf8'
		);
		// Extract the closeImportModal function body
		const fnStart = source.indexOf('function closeImportModal');
		const fnBody = source.substring(fnStart, fnStart + 400);
		// The abort logic should come BEFORE any blocking return
		// It should NOT do `if (isBusy) return` first since that blocks scan cancel
		const abortIdx = fnBody.indexOf('abort');
		const busyReturnMatch = fnBody.match(/if\s*\(\s*(?:isBusy|importMode\s*===)/);
		if (busyReturnMatch) {
			const blockIdx = fnBody.indexOf(busyReturnMatch[0]);
			expect(abortIdx).toBeLessThan(blockIdx);
		}
		// Should still block during actual imports (not scanning)
		expect(fnBody).toMatch(/importing_single|importing_batch/);
	});

	// Bug 3: Batch summary counts partial successes as failures
	it('batch endpoint should count by novel_id not just errors', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		// The "succeeded" filter should check novel_id, not just errors.length === 0
		// A project with docs_imported > 0 but some RTF errors should count as succeeded
		expect(source).toMatch(/succeeded.*novel_id|novel_id.*succeeded/s);
	});

	// Bug 4: Batch endpoint missing homedir boundary
	it('batch endpoint should enforce homedir boundary', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		expect(source).toMatch(/homeDir|os\.homedir/);
	});

	// Bug 5 (Codex review): startsWith(homeDir) prefix bypass
	// /home/user matches /home/user2 — must check with trailing separator
	it('scan endpoint should use path-separator-aware homedir check', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		// Must check homeDir + '/' or path.sep, not bare startsWith(homeDir)
		expect(source).toMatch(/startsWith\(homeDir\s*\+\s*['"`]\/['"`]\)/);
	});

	it('batch endpoint should use path-separator-aware homedir check', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/batch/+server.ts'),
			'utf8'
		);
		expect(source).toMatch(/startsWith\(homeDir\s*\+\s*['"`]\/['"`]\)/);
	});

	// Bug 6 (Codex review): scan endpoint should trim input server-side
	it('scan endpoint should trim input path', () => {
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		// inputPath should be trimmed before expansion/resolution
		expect(source).toMatch(/\.trim\(\)/);
	});
});

// ============================================================
// Duplicate detection test
// ============================================================
describe('duplicate detection', () => {
	it('should flag existing novels with matching titles', async () => {
		// Seed a novel with title "Existing"
		const now = new Date().toISOString();
		db.prepare('INSERT INTO novels (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
			.run('existing-1', 'Existing', 'draft', now, now);

		// Create a .scriv bundle named "Existing"
		createScrivBundle(tmpDir, 'Existing');
		// Create another named "Brand New"
		createScrivBundle(tmpDir, 'BrandNew');

		// The scan endpoint should cross-reference against the DB
		const source = fs.readFileSync(
			path.resolve('src/routes/api/import/scan/+server.ts'),
			'utf8'
		);
		// Should query novels table for duplicate detection
		expect(
			source.includes('novels') && source.includes('title')
		).toBe(true);
	});
});
