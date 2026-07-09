import { realpathSync, statSync } from 'fs';
import os from 'os';

export interface ResolvedPath {
	resolved: string;
}

export interface ResolvePathError {
	error: string;
}

/**
 * Expand a leading `~`, resolve symlinks, and enforce that the result is
 * within the user's home directory and is a directory. Mirrors the
 * boundary checks already used by the scan/batch import endpoints
 * (P1-6) so every import entry point enforces the same guarantee.
 */
export function resolveImportPath(inputPath: string): ResolvedPath | ResolvePathError {
	const homeDir = os.homedir();

	// Expand tilde — Node.js doesn't do shell-style ~ expansion
	const expanded = inputPath.replace(/^~(?=$|\/)/, homeDir);

	let resolved: string;
	try {
		resolved = realpathSync(expanded);
	} catch {
		return { error: 'Path does not exist' };
	}

	// Use homeDir + '/' to prevent prefix bypass (/home/user matching /home/user2)
	if (resolved !== homeDir && !resolved.startsWith(homeDir + '/')) {
		return { error: 'Path must be within your home directory' };
	}

	try {
		const stat = statSync(resolved);
		if (!stat.isDirectory()) {
			return { error: 'Path is not a directory' };
		}
	} catch {
		return { error: 'Cannot access path' };
	}

	return { resolved };
}
