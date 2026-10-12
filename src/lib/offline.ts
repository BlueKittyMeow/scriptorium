import type { TreeNode } from './types.js';
import { readingOrder } from './chapters.js';

export type LocalWork = { id: string; userId: string; novel: any; tree: TreeNode[]; downloadedAt: string };
export type LocalDocument = { id: string; novel_id: string; title: string; content: string; content_revision: string; [key: string]: any };
export type Draft = { id: string; userId: string; document: LocalDocument; content: string; base_revision: string; generation: number; dirty: boolean; savedAt: string };
const databaseName = 'scriptorium-offline-v1';
let database: Promise<IDBDatabase> | undefined;
function db() {
	return database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = () => request.result.createObjectStore('records');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => { database = undefined; reject(new Error('Device storage is unavailable. Keep this tab open and download your writing.')); };
	});
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
	const database = await db();
	return new Promise((resolve, reject) => {
		const tx = database.transaction('records', mode);
		let value: T;
		tx.oncomplete = () => resolve(value);
		tx.onabort = tx.onerror = () => reject(new Error('Could not save on this device. Storage may be full or another tab changed this draft. Keep this tab open and download a copy.'));
		try { action(tx.objectStore('records'), v => value = v); } catch (error) { tx.abort(); reject(error); }
	});
}
function protect(store: IDBObjectStore, callback: () => void) {
	return () => { try { callback(); } catch { store.transaction.abort(); } };
}
export async function localGet<T>(key: string): Promise<T | undefined> {
	return transaction('readonly', (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); });
}
async function put(key: string, value: unknown): Promise<void> {
	return transaction('readwrite', (s, done) => { s.put(value, key); done(); });
}
async function records<T>(prefix: string): Promise<T[]> {
	return transaction('readonly', (s, done) => {
		const r = s.getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'));
		r.onsuccess = () => done(r.result);
	});
}
export const setLocalAccount = (user: { id: string; username: string }) => put('account', user);
export const localAccount = () => localGet<{ id: string; username: string }>('account');
export const localWorks = (userId: string) => records<LocalWork>(`work:${userId}:`);
export const localDrafts = async (userId: string) => (await records<Draft>(`draft:${userId}:`)).filter(d => d.dirty);
export const getLocalDocument = (userId: string, id: string) => localGet<LocalDocument>(`doc:${userId}:${id}`);
export const getDraft = (userId: string, id: string) => localGet<Draft>(`draft:${userId}:${id}`);
export const cacheDocument = (userId: string, doc: LocalDocument) => put(`doc:${userId}:${doc.id}`, doc);

/** The generation comparison is atomic across tabs, not just within this component. */
export async function saveDraft(userId: string, doc: LocalDocument, content: string, expected: number): Promise<Draft> {
	return transaction('readwrite', (s, done) => {
		const key = `draft:${userId}:${doc.id}`;
		const r = s.get(key);
		r.onsuccess = protect(s, () => {
			const old = r.result as Draft | undefined;
			if ((old?.generation ?? 0) !== expected && old?.content !== content) { s.transaction.abort(); return; }
			const draft: Draft = { id: doc.id, userId, document: doc, content, base_revision: old?.dirty ? old.base_revision : doc.content_revision, dirty: true,
				generation: (old?.generation ?? 0) + 1, savedAt: new Date().toISOString() };
			s.put(draft, key); done(draft);
		});
	});
}
export async function syncDraft(draft: Draft): Promise<void> {
	const identity = await fetch('/api/auth/me', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
	if (!identity.ok || (await identity.json()).user?.id !== draft.userId) throw new Error('Sign in to the account that saved this work before syncing.');
	const response = await fetch(`/api/documents/${draft.id}`, { method: 'PUT', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: draft.content, base_revision: draft.base_revision }) });
	if (!response.ok) {
		if (response.status === 409) throw new Error('Conflict: the server has a different version. Both versions are kept. Download your device copy and compare it with the server copy.');
		if (response.status === 404) throw new Error('This chapter is no longer available on the server. Your device copy is kept.');
		throw new Error('Not synced yet. Your writing is saved on this device; reconnect or sign in and retry.');
	}
	const result = await response.json();
	if (typeof result.content_revision !== 'string') throw new Error('The server did not confirm the saved version. Your device copy is kept.');
	await transaction<void>('readwrite', (s, done) => {
		const key = `draft:${draft.userId}:${draft.id}`;
		const r = s.get(key);
		r.onsuccess = protect(s, () => {
			const current = r.result as Draft | undefined;
			if (current?.generation === draft.generation && current.content === draft.content) s.put({ ...current, dirty: false, base_revision: result.content_revision }, key);
			else if (current?.base_revision === draft.base_revision) s.put({ ...current, base_revision: result.content_revision }, key);
			s.put({ ...draft.document, ...result, content: draft.content }, `doc:${draft.userId}:${draft.id}`);
			done();
		});
	});
}
export async function downloadWork(userId: string, novel: any, tree: TreeNode[], progress: (message: string) => void) {
	if (!('serviceWorker' in navigator)) throw new Error('This browser cannot reopen Scriptorium offline. You can still export your work.');
	const registration = await navigator.serviceWorker.getRegistration();
	if (!registration) throw new Error('Offline support is not ready. Reload the app while connected, then try again.');
	await navigator.serviceWorker.ready;
	const docs = readingOrder(tree);
	for (let i = 0; i < docs.length; i++) {
		progress(`Saving chapter ${i + 1} of ${docs.length} on this device…`);
		const r = await fetch(`/api/documents/${docs[i].id}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
		if (!r.ok) throw new Error(`Could not download “${docs[i].title}”. Try again when the server is available.`);
		const doc = await r.json();
		if (typeof doc.content !== 'string' || typeof doc.content_revision !== 'string') throw new Error('The server returned an incomplete chapter. Download not complete.');
		await cacheDocument(userId, doc);
	}
	// Publish only once every chapter is available. Existing unsynced drafts are separate.
	await put(`work:${userId}:${novel.id}`, { id: novel.id, userId, novel, tree, downloadedAt: new Date().toISOString() } satisfies LocalWork);
	const persistent = await navigator.storage?.persist?.().catch(() => false);
	progress(persistent ? 'Work saved on this device for offline reading and writing.' : 'Work saved on this device. This browser may clear its storage; keep regular exports too.');
}
export async function clearLocalCopies(userId: string): Promise<void> {
	return transaction('readwrite', (s, done) => {
		const drafts = s.getAll(IDBKeyRange.bound(`draft:${userId}:`, `draft:${userId}:\uffff`));
		drafts.onsuccess = protect(s, () => {
			if (drafts.result.some((d: Draft) => d.dirty)) { s.transaction.abort(); return; }
			for (const prefix of [`work:${userId}:`, `doc:${userId}:`, `draft:${userId}:`]) s.delete(IDBKeyRange.bound(prefix, prefix + '\uffff'));
			done();
		});
	});
}
export const lockLocalAccount = () => transaction<void>('readwrite', (s, done) => { s.delete('account'); done(); });
