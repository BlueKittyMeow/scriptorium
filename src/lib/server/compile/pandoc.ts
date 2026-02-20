import { execFile } from 'child_process';
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
		const { stdout } = await execFileAsync('pandoc', args, {
			encoding: 'buffer',
			maxBuffer: 50 * 1024 * 1024, // 50MB
			timeout: 60000
		});

		// For binary formats, stdout is a Buffer via encoding: 'buffer'
		// For text formats (markdown), stdout is still a Buffer
		const inputBuffer = Buffer.from(html, 'utf-8');

		// We need to use spawn for stdin piping since execFile doesn't support it directly
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

function buildPandocArgs(format: CompileFormat, metadata: CompileMetadata): string[] {
	const pandocFormat = format === 'markdown' ? 'markdown' : format;
	const args = [
		'-f', 'html',
		'-t', pandocFormat,
		'--standalone',
		`--metadata=title:${metadata.title}`
	];

	if (metadata.subtitle) {
		args.push(`--metadata=subtitle:${metadata.subtitle}`);
	}

	if (format === 'pdf') {
		args.push('--pdf-engine=wkhtmltopdf');
	}

	return args;
}

/** Spawn Pandoc with stdin piping for proper binary output handling */
function spawnPandoc(args: string[], input: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const { spawn } = require('child_process');
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

		proc.stdin.write(input);
		proc.stdin.end();
	});
}
