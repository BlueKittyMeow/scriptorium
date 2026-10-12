import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { apiFetch, apiFailure } from '$lib/api.js';
import { publicServerError } from '$lib/server/errors.js';

beforeEach(() => apiFailure.set(null));
afterEach(() => vi.unstubAllGlobals());
const treeUrl = '/api/novels/book/tree';

describe('actionable request failures', () => {
	it.each([
		[401, 'Sign in in a new tab'], [403, 'right account'], [404, 'Trash'],
		[409, 'current state'], [413, 'smaller document'], [429, 'Wait a minute'],
		[500, 'unexpected problem'], [502, 'temporarily unavailable'], [503, 'temporarily unavailable'],
		[504, 'temporarily unavailable'], [507, 'run out of storage']
	])('explains HTTP %s without replacing it with chapter data', async (status, phrase) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>proxy error</h1>', { status: Number(status) })));
		const response = await apiFetch(treeUrl);
		expect(response.ok).toBe(false);
		expect((await response.json()).message).toContain(phrase);
		expect(get(apiFailure)?.message).toContain('load chapters');
		expect(get(apiFailure)?.message).not.toContain('<h1>');
		expect(get(apiFailure)?.signIn).toBe(status === 401);
	});
	it('preserves validation detail but does not expose an internal server exception', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'Title is required' }, { status: 400 })));
		expect((await (await apiFetch('/api/novels', { method: 'POST' })).json()).message).toContain('Title is required');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'secret /private/path SQL' }, { status: 500 })));
		expect((await (await apiFetch(treeUrl)).json()).message).not.toContain('secret');
	});
	it('reports a network failure and never automatically retries a save', async () => {
		const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
		vi.stubGlobal('fetch', fetch);
		const response = await apiFetch('/api/documents/chapter', { method: 'PUT', body: 'draft' });
		expect(response.ok).toBe(false);
		expect((await response.json()).message).toContain('Keep this tab open');
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(['<html>login</html>', 'null', '{}', '[{"id":"bad"}]'])('rejects invalid chapter-list payload %s', async (payload) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload)));
		expect((await apiFetch(treeUrl)).ok).toBe(false);
		expect(get(apiFailure)?.message).toContain('unreadable response');
	});
	it('does not accept missing chapter content as an empty document', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'chapter', message: 'error' })));
		expect((await apiFetch('/api/documents/chapter')).ok).toBe(false);
	});
	it('keeps a save error visible when an unrelated list loads successfully', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
			.mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json({ word_count: 20 })));
		await apiFetch('/api/documents/chapter', { method: 'PUT' });
		await apiFetch(treeUrl);
		expect(get(apiFailure)).not.toBeNull();
		await apiFetch('/api/documents/chapter', { method: 'PUT' });
		expect(get(apiFailure)).toBeNull();
	});
	it('preserves successful binary exports', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
		const response = await apiFetch('/api/novels/book/compile', { method: 'POST' });
		expect(response.ok).toBe(true);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
	});
	it('does not announce intentionally cancelled scans', async () => {
		const controller = new AbortController(); controller.abort();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')));
		await expect(apiFetch('/api/import/scan', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(get(apiFailure)).toBeNull();
	});
	it.each(['ENOSPC', 'SQLITE_FULL', 'EACCES', 'EIO', 'SQLITE_BUSY', 'UNKNOWN'])('classifies %s without leaking exception text', (code) => {
		const result = publicServerError({ code, message: '/private/file manuscript text' });
		expect(result.message).not.toContain('private');
		expect(result.message).not.toContain('manuscript');
		expect(result.code).not.toBe('UNKNOWN');
	});
});
