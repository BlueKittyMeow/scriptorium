import { describe, expect, it, vi } from 'vitest';
import { chapterNumbers, readingOrder } from '../src/lib/chapters.js';
import type { TreeNode } from '../src/lib/types.js';
import { createTestDb, seedNovelWithDocs, seedUser } from './helpers.js';
import { PATCH } from '../src/routes/api/novels/[id]/tree/nodes/[nodeId]/+server.js';
vi.mock('$lib/server/db.js', () => ({ getDataRoot: () => '/tmp/unused-chapter-tests' }));
const doc = (id: string, sort_order = 1, extra = {}): TreeNode => ({ id, title: id, type: 'document', sort_order, children: [], deleted_at: null, ...extra });
const folder = (id: string, children: TreeNode[], extra = {}): TreeNode => ({ ...doc(id), type: 'folder', children, ...extra });
describe('chapter numbering and reading order', () => {
	it('restarts in each folder, skipping epigraphs without changing titles', () => {
		const tree = [folder('one', [doc('a'), doc('epigraph', 2, { numbering_include: 0 }), doc('b', 3)]), folder('two', [doc('c')])];
		expect([...chapterNumbers(tree, true)]).toEqual([['a', 1], ['b', 2], ['c', 1]]);
		expect(tree[0].children[0].title).toBe('a');
	});
	it('folder opt-outs are independent and the whole work can disable numbering', () => {
		const tree = [folder('one', [doc('a'), folder('nested', [doc('b')])], { numbering_enabled: 0 })];
		expect([...chapterNumbers(tree, true)]).toEqual([['b', 1]]);
		expect(chapterNumbers(tree, false).size).toBe(0);
	});
	it('reordering recomputes numbers; navigation includes unnumbered text and skips trashed subtrees', () => {
		const tree = [doc('b', 4), doc('epi', 0, { numbering_include: 0 }), doc('a', 1), folder('trash', [doc('hidden')], { deleted_at: 'today' })];
		expect(readingOrder(tree).map(n => n.id)).toEqual(['epi', 'a', 'b']);
		expect([...chapterNumbers(tree, true)]).toEqual([['a', 1], ['b', 2]]);
	});
	it('persists exclusions and rejects invalid values and cross-work node ids', async () => {
		const db = createTestDb();
		try {
			const user = seedUser(db), ids = seedNovelWithDocs(db);
			const request = (body: unknown, id = ids.novelId) => PATCH({ params: { id, nodeId: ids.doc1Id }, locals: { db, user }, request: new Request('http://test', { method: 'PATCH', body: JSON.stringify(body) }) } as any);
			await request({ numbering_include: false });
			expect(db.prepare('SELECT numbering_include FROM documents WHERE id = ?').get(ids.doc1Id)).toEqual({ numbering_include: 0 });
			await expect(request({ numbering_include: 'no' })).rejects.toMatchObject({ status: 400 });
			await expect(request({ numbering_include: true }, 'different-work')).rejects.toMatchObject({ status: 404 });
		} finally { db.close(); }
	});
});

it('compiled headings match folder numbering and document exclusions', async () => {
 const db = createTestDb();
 try {
  seedNovelWithDocs(db);
  db.prepare('UPDATE novels SET numbering_enabled=1').run();
  db.prepare("UPDATE documents SET numbering_include=0 WHERE id='doc-1'").run();
  const { collectCompileDocuments } = await import('../src/lib/server/compile/tree-walk.js');
  const docs = collectCompileDocuments(db,'novel-1');
  expect(docs.find(d=>d.id==='doc-1')?.title).not.toMatch(/^1\./);
  expect(docs.find(d=>d.id==='doc-2')?.title).toMatch(/^1\./);
 } finally { db.close(); }
});
