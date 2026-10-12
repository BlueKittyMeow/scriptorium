import { writable } from 'svelte/store';

export type ApiFailure = { message: string; status: number; key: string; signIn: boolean };
export const apiFailure = writable<ApiFailure | null>(null);

export function showNotice(message: string) {
	apiFailure.set({ message, status: 0, key: 'notice', signIn: false });
}

function validTree(value: unknown): boolean {
	return Array.isArray(value) && value.every((node) => node && typeof node.id === 'string' &&
		typeof node.title === 'string' && ['folder', 'document'].includes(node.type) && validTree(node.children));
}

function validPayload(path: string, method: string, value: any): boolean {
	if (value === null || typeof value !== 'object') return false;
	if (method !== 'GET') return true;
	if (path.endsWith('/tree')) return validTree(value);
	if (/^\/api\/documents\/[^/]+$/.test(path)) return typeof value.id === 'string' && typeof value.content === 'string';
	if (['/api/novels', '/api/collections', '/api/search', '/api/feedback', '/api/roadmap/hearts'].includes(path) || path.endsWith('/snapshots')) return Array.isArray(value);
	return true;
}

function actionFor(path: string, method: string): string {
	const read = method === 'GET';
	if (path === '/api/auth/login') return 'sign in';
	if (path === '/api/auth/logout') return 'sign out';
	if (path === '/api/auth/setup') return 'create your account';
	if (path.includes('/compile')) return 'export your novel';
	if (path.includes('/import')) return 'import your files';
	if (path.includes('/compare')) return 'compare or merge the documents';
	if (path.includes('/snapshots')) return read ? 'load snapshots' : 'create a snapshot';
	if (path.includes('/restore')) return 'restore this item';
	if (path.includes('/purge')) return 'permanently delete this item';
	if (path.startsWith('/api/documents/')) return read ? 'load this chapter' : 'save this chapter';
	if (path.endsWith('/tree')) return read ? 'load chapters' : 'move this item';
	if (path.includes('/tree/nodes')) return method === 'DELETE' ? 'move this item to Trash' : 'update the binder';
	if (path.startsWith('/api/novels')) return read ? 'load your library' : 'update this novel';
	if (path.startsWith('/api/collections')) return read ? 'load shelves' : 'update shelves';
	if (path.startsWith('/api/search')) return 'search your writing';
	if (path.startsWith('/api/admin/users')) return read ? 'load accounts' : 'update this account';
	if (path.startsWith('/api/admin/trash')) return 'load Trash';
	if (path.startsWith('/api/admin/storage')) return 'load storage information';
	if (path.startsWith('/api/admin/audit')) return 'load the activity log';
	if (path.startsWith('/api/feedback')) return read ? 'load requests and questions' : 'save your feedback';
	if (path.startsWith('/api/roadmap')) return read ? 'load roadmap hearts' : 'save your heart';
	return 'complete this action';
}

export function failureMessage(status: number, action: string, detail?: string, mutation = false): string {
	const prefix = `Could not ${action}. `;
	if (status === 401) return prefix + (action === 'sign in'
		? 'The username or password was not accepted. Check both and try again.'
		: 'Your sign-in has expired or is missing. Sign in in a new tab, then return here and retry. Keep this tab open if you have unsaved writing.');
	if (status === 403) return prefix + 'Access was denied. Check that you are signed in with the right account. If this continues, contact your archivist.';
	if (status === 404) return prefix + 'This item could not be found. It may have moved to Trash. Refresh the list after saving any open writing.';
	if (status === 409) return prefix + (detail || 'The item changed or already exists. Check its current state before trying again.');
	if (status === 413) return prefix + 'This request is too large. Keep a copy of your writing and try a smaller document or import.';
	if (status === 429) return prefix + 'Too many requests arrived at once. Wait a minute, then try again.';
	if (status === 400 || status === 422) return prefix + (detail || 'Some information was not accepted. Check the fields and try again.');
	if (status === 507) return prefix + 'The server has run out of storage. Keep this tab open and download a copy of unsaved writing. Ask your archivist to free space before retrying.';
	if (status >= 500 && detail) return prefix + detail;
	if (status === 502 || status === 503 || status === 504) return prefix + 'The server is temporarily unavailable. Keep this tab open and retry shortly.' +
		(mutation ? ' A change may have reached the server even if its confirmation did not arrive.' : '');
	return prefix + (detail || 'The server encountered an unexpected problem. Keep any unsaved writing, then try again. If it continues, contact your archivist.');
}

/** A fetch-compatible boundary: failures always have JSON and are announced.
 * Callers must check .ok BEFORE applying data or clearing form/editor state.
 * No automatic redirects or mutation retries: both can lose a writer's work.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
	const path = input.split('?')[0];
	const method = (init.method || 'GET').toUpperCase();
	const key = `${method} ${path}`;
	const action = actionFor(path, method);
	function fail(status: number, message: string) {
		apiFailure.set({ message, status, key, signIn: status === 401 && action !== 'sign in' });
		return Response.json({ message }, { status });
	}
	let response: Response;
	try {
		const headers = new Headers(init.headers);
		if (!headers.has('Accept')) headers.set('Accept', 'application/json');
		response = await fetch(input, { ...init, headers });
	} catch (error) {
		if (init.signal?.aborted) throw error; // Deliberately cancelled import scan.
		return fail(503, `Could not ${action}. The connection was interrupted. Check your connection and retry. Keep this tab open if you have unsaved writing.` +
			(method !== 'GET' ? ' The server may not have received your last change.' : ''));
	}
	if (response.redirected && new URL(response.url).pathname === '/login') {
		return fail(401, failureMessage(401, action));
	}
	if (!response.ok) {
		const body = await response.clone().json().catch(() => null);
		// Do not display proxy HTML, stack traces, or unclassified server internals.
		const safeCodes = ['CONTENT_UNAVAILABLE', 'EXPORT_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'SERVER_BUSY'];
		const safeDetail = typeof body?.message === 'string' &&
			(response.status < 500 || safeCodes.includes(body?.code))
			? body.message.slice(0, 500) : undefined;
		const status = body?.code === 'STORAGE_FULL' ? 507 : response.status;
		return fail(status, failureMessage(status, action, safeDetail, method !== 'GET'));
	}
	// Export returns a file. All other fetch endpoints return JSON.
	if (!path.endsWith('/compile') && response.status !== 204) {
		try {
			const value = await response.clone().json();
			if (!validPayload(path, method, value)) throw new Error('Invalid response');
		} catch (error) {
			if (init.signal?.aborted) throw error;
			return fail(502, `Could not ${action}. The server returned an unreadable response. Keep any unsaved writing and try again; if this continues, contact your archivist.`);
		}
	}
	apiFailure.update((current) => current?.key === key ? null : current);
	return response;
}
