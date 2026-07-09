import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { CompileFormat, CompileResult, CompileMetadata } from './types.js';
import { FORMAT_CONFIG } from './types.js';

const execFileAsync = promisify(execFile);

/** Check if Pandoc is available on the system */
export async function checkPandocAvailable(): Promise<boolean> {
	try {
		await execFileAsync('pandoc', ['--version']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Convert HTML to the specified output format using Pandoc.
 * Uses stdin/stdout piping — no temp files needed.
 */
export async function convertHtmlToFormat(
	html: string,
	format: CompileFormat,
	metadata: CompileMetadata
): Promise<CompileResult> {
	const args = buildPandocArgs(format, metadata);
	const config = FORMAT_CONFIG[format];

	try {
		const inputBuffer = Buffer.from(html, 'utf-8');
		const result = await spawnPandoc(args, inputBuffer);

		return {
			buffer: result,
			mimeType: config.mimeType,
			extension: config.extension
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Pandoc conversion failed: ${message}`);
	}
}

/**
 * Build the Pandoc CLI args for a given output format.
 *
 * Metadata policy (see docs/remediation-plan-2026-07.md P1-10):
 * the assembled HTML already carries a generated title-page div, so passing
 * --metadata=title/subtitle to pandoc's docx/markdown/pdf writers would make
 * them ALSO emit their own title block, stacking two title pages. Only epub
 * keeps the metadata flags — the EPUB OPF package requires a <dc:title>, and
 * (per assemble.ts's `includeTitlePage` option) the epub compile path should
 * omit the generated HTML title-page div to avoid a duplicate there too.
 */
export function buildPandocArgs(format: CompileFormat, metadata: CompileMetadata): string[] {
	const pandocFormat = format === 'markdown' ? 'markdown' : format;
	const args = [
		'-f', 'html',
		'-t', pandocFormat,
		'--standalone'
	];

	if (format === 'epub') {
		args.push(`--metadata=title:${metadata.title}`);
		if (metadata.subtitle) {
			args.push(`--metadata=subtitle:${metadata.subtitle}`);
		}
	}

	if (format === 'pdf') {
		args.push('--pdf-engine=wkhtmltopdf');
	}

	return args;
}

/** Spawn Pandoc with stdin piping for proper binary output handling */
function spawnPandoc(args: string[], input: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const proc = spawn('pandoc', args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: 60000
		});

		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];

		proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

		proc.on('close', (code: number) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				const stderr = Buffer.concat(errChunks).toString('utf-8');
				reject(new Error(`Pandoc exited with code ${code}: ${stderr}`));
			}
		});

		proc.on('error', (err: Error) => reject(err));

		// If pandoc dies before/while we write (bad args, OOM), writing to its
		// closed stdin can emit an unhandled EPIPE that crashes the process.
		// The `close` handler above already reports the real failure, so just
		// swallow stdin errors here.
		proc.stdin.on('error', () => {});

		proc.stdin.write(input);
		proc.stdin.end();
	});
}
