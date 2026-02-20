import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb } from './helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
	db = createTestDb();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriv-test-'));
});

/**
 * Bug: Import sort order collision
 *
 * All root-level binder items are passed sortOrder=1.0 in the loop at
 * scriv.ts:129-131. Multiple top-level folders (Manuscript, Research, Notes)
 * all collide at sort_order=1.0.
 */
describe('import sort order', () => {
	it('should assign distinct sort_order to root-level binder items', async () => {
		// Create a minimal .scriv project with 3 top-level folders
		const scrivDir = path.join(tmpDir, 'Test.scriv');
		fs.mkdirSync(path.join(scrivDir, 'Files', 'Docs'), { recursive: true });

		const scrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject>
  <Binder>
    <BinderItem ID="1" Type="Folder" Created="" Modified="">
      <Title>Manuscript</Title>
    </BinderItem>
    <BinderItem ID="2" Type="Folder" Created="" Modified="">
      <Title>Research</Title>
    </BinderItem>
    <BinderItem ID="3" Type="Folder" Created="" Modified="">
      <Title>Notes</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;

		fs.writeFileSync(path.join(scrivDir, 'Test.scrivx'), scrivx);

		// We need to mock the data root for file operations
		// Import the function - we'll need to handle the $lib alias
		const { importScriv } = await import('$lib/server/import/scriv.js');

		const report = await importScriv(db, scrivDir);

		// Verify all 3 folders were created
		const folders = db.prepare('SELECT title, sort_order FROM folders ORDER BY sort_order').all() as any[];
		expect(folders).toHaveLength(3);

		// Each should have a DISTINCT sort_order
		const sortOrders = folders.map((f: any) => f.sort_order);
		const uniqueSortOrders = new Set(sortOrders);
		expect(uniqueSortOrders.size).toBe(3);

		// They should be in order: Manuscript=1, Research=2, Notes=3
		expect(sortOrders[0]).toBeLessThan(sortOrders[1]);
		expect(sortOrders[1]).toBeLessThan(sortOrders[2]);
	});
});

/**
 * Bug: Import not wrapped in transaction
 *
 * A failure mid-import leaves a partial novel in the database.
 * We test that if the import fails, no novel is left behind.
 */
describe('import transaction safety', () => {
	it('should not leave partial data on import failure', async () => {
		// Create a .scriv project where the XML references a document
		// whose RTF conversion will fail (corrupt/missing file)
		const scrivDir = path.join(tmpDir, 'Broken.scriv');
		fs.mkdirSync(path.join(scrivDir, 'Files', 'Docs'), { recursive: true });

		// Reference a document with ID "99" but write an invalid RTF file for it
		const scrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject>
  <Binder>
    <BinderItem ID="1" Type="Folder" Created="" Modified="">
      <Title>Good Folder</Title>
      <Children>
        <BinderItem ID="99" Type="Text" Created="" Modified="">
          <Title>Bad Doc</Title>
        </BinderItem>
      </Children>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;

		fs.writeFileSync(path.join(scrivDir, 'Broken.scrivx'), scrivx);
		// Write a corrupt RTF that will cause convertRtf to fail
		fs.writeFileSync(path.join(scrivDir, 'Files', 'Docs', '99.rtf'), 'NOT VALID RTF AT ALL {{{');

		const { importScriv } = await import('$lib/server/import/scriv.js');

		// The import might succeed with warnings (RTF conversion gracefully fails)
		// or throw. Either way, if a novel IS created, it should be complete.
		try {
			const report = await importScriv(db, scrivDir);
			// If it succeeded, verify data consistency
			const novels = db.prepare('SELECT * FROM novels').all();
			if (novels.length > 0) {
				// All referenced items should exist
				const folders = db.prepare('SELECT * FROM folders WHERE novel_id = ?').all(report.novel_id);
				expect(folders.length).toBeGreaterThan(0);
			}
		} catch {
			// If it threw, there should be NO partial novel data
			const novels = db.prepare('SELECT * FROM novels').all();
			expect(novels).toHaveLength(0);
			const folders = db.prepare('SELECT * FROM folders').all();
			expect(folders).toHaveLength(0);
			const documents = db.prepare('SELECT * FROM documents').all();
			expect(documents).toHaveLength(0);
		}
	});
});
