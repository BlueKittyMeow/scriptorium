import { readdir } from 'fs/promises';
import { readdirSync } from 'fs';
import path from 'path';

export interface ScanOptions {
	maxDepth?: number;
	skipHidden?: boolean;
}

const SKIP_DIRS = new Set([
	'node_modules', '__pycache__', '.git', '.svn', 'Trash', '.Trash'
]);

/**
 * Recursively scan a directory for valid .scriv project bundles.
 *
 * Uses fs.promises.readdir to avoid blocking the event loop.
 * dirent.isDirectory() naturally returns false for symlinks,
 * so symlinked directories are never traversed (no cycle risk).
 *
 * @param directory - Root directory to scan
 * @param options - maxDepth (default 5), skipHidden (default true)
 * @returns Array of { path, name } for each valid .scriv bundle found
 */
export async function scanForScrivProjects(
	directory: string,
	options?: ScanOptions
): Promise<{ path: string; name: string }[]> {
	const maxDepth = options?.maxDepth ?? 5;
	const skipHidden = options?.skipHidden ?? true;

	const results: { path: string; name: string }[] = [];

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > maxDepth) return;

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			// Permission denied, broken path, etc. — skip silently
			return;
		}

		for (const entry of entries) {
			// dirent.isDirectory() returns false for symlinks — safe by default
			if (!entry.isDirectory()) continue;

			const name = entry.name;

			// Skip hidden directories
			if (skipHidden && name.startsWith('.')) continue;

			// Skip known non-project directories
			if (SKIP_DIRS.has(name)) continue;

			const fullPath = path.join(dir, name);

			if (name.endsWith('.scriv')) {
				// Validate: must contain at least one .scrivx file
				if (hasScrivxFile(fullPath)) {
					const projectName = name.replace(/\.scriv$/, '');
					results.push({ path: fullPath, name: projectName });
				}
				// Don't recurse into .scriv directories either way
				continue;
			}

			// Recurse into regular directories
			await walk(fullPath, depth + 1);
		}
	}

	await walk(directory, 0);
	return results;
}

/**
 * Check if a .scriv directory contains at least one .scrivx file.
 * Uses synchronous readdir since we're checking a single small directory.
 */
function hasScrivxFile(scrivDir: string): boolean {
	try {
		const files = readdirSync(scrivDir);
		return files.some(f => f.endsWith('.scrivx'));
	} catch {
		return false;
	}
}
