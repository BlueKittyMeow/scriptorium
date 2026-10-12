/** Public error messages contain no paths, queries, credentials, or manuscript text. */
export function publicServerError(error: unknown): { message: string; code: string } {
	const code = (error as { code?: string } | null)?.code;
	if (code === 'ENOSPC' || code === 'SQLITE_FULL') return {
		code: 'STORAGE_FULL', message: 'The server has run out of storage. Keep a copy of unsaved writing and contact your archivist.'
	};
	if (code === 'EACCES' || code === 'EPERM' || code?.startsWith('SQLITE_READONLY')) return {
		code: 'STORAGE_UNAVAILABLE', message: 'The server cannot access its writing storage. Keep any unsaved writing and contact your archivist.'
	};
	if (code === 'EIO' || code === 'ENODEV' || code === 'SQLITE_IOERR' || code === 'SQLITE_CANTOPEN') return {
		code: 'STORAGE_UNAVAILABLE', message: 'The server cannot read or write its storage right now. Keep any unsaved writing and contact your archivist.'
	};
	if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return {
		code: 'SERVER_BUSY', message: 'The server is busy saving another change. Wait a moment, then retry.'
	};
	return { code: 'SERVER_ERROR', message: 'The server encountered an unexpected problem. Keep any unsaved writing and try again. If it continues, contact your archivist.' };
}
