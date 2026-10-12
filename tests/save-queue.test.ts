import { describe, expect, it, vi } from 'vitest';
import { SaveQueue, type SaveStatus } from '$lib/save-queue.js';

describe('writing survives failed and overlapping saves', () => {
	it('returns failure, keeps work dirty, and allows an explicit retry', async () => {
		let status: SaveStatus = 'saved';
		const draft = { content: '<p>Unsaved writing</p>', docId: 'first' };
		const save = vi.fn().mockRejectedValueOnce(new Error('401')).mockResolvedValueOnce(undefined);
		const queue = new SaveQueue(() => draft, save, next => { status = next; });
		queue.markDirty();
		expect(await queue.flush()).toBe(false);
		expect(status).toBe('unsaved');
		expect(draft.content).toContain('Unsaved writing');
		expect(await queue.flush()).toBe(true);
		expect(status).toBe('saved');
		expect(save).toHaveBeenNthCalledWith(2, '<p>Unsaved writing</p>', 'first');
	});
	it('waits for the latest text and serializes concurrent flush requests', async () => {
		let finish!: () => void;
		let draft = { content: 'old text', docId: 'first' };
		const statuses: SaveStatus[] = [];
		const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
		const queue = new SaveQueue(() => draft, save, next => statuses.push(next));
		queue.markDirty();
		const first = queue.flush();
		await Promise.resolve();
		draft = { content: 'new text typed during the request', docId: 'first' };
		queue.markDirty();
		const second = queue.flush();
		expect(save).toHaveBeenCalledTimes(1);
		finish();
		expect(await Promise.all([first, second])).toEqual([true, true]);
		expect(save.mock.calls).toEqual([['old text', 'first'], ['new text typed during the request', 'first']]);
		expect(statuses.filter(s => s === 'saved')).toHaveLength(1);
	});
	it('captures the content and owning document before awaiting a save', async () => {
		let draft = { content: 'belongs to first', docId: 'first' };
		const save = vi.fn().mockResolvedValue(undefined);
		const queue = new SaveQueue(() => draft, save, () => {});
		queue.markDirty(); const pending = queue.flush();
		draft = { content: 'second', docId: 'second' };
		await pending;
		expect(save).toHaveBeenCalledExactlyOnceWith('belongs to first', 'first');
	});
	it('does not write simply because a document is opened or flushed twice', async () => {
		const save = vi.fn();
		const queue = new SaveQueue(() => ({ content: 'read only', docId: 'first' }), save, () => {});
		expect(await queue.flush()).toBe(true);
		queue.reset(); await queue.flush();
		expect(save).not.toHaveBeenCalled();
	});
});
