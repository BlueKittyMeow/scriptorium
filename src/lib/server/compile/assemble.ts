import type { CompileDocument, CompileMetadata } from './types.js';

export interface AssembleResult {
	html: string;
	warnings: string[];
}

/**
 * Assemble a complete HTML document from compiled documents.
 * Generates a title page and wraps each document in a section with chapter heading.
 *
 * @param documents - Ordered list of documents to include
 * @param metadata - Novel title and subtitle
 * @param readContent - Function to read document content from disk
 */
export function assembleCompileHtml(
	documents: CompileDocument[],
	metadata: CompileMetadata,
	readContent: (novelId: string, docId: string) => string | null
): AssembleResult {
	const warnings: string[] = [];
	const titlePage = buildTitlePage(metadata);
	const chapters = documents.map(doc => {
		const content = readContent(doc.novelId, doc.id);
		if (content === null) {
			warnings.push(`Missing content file for "${doc.title}" (${doc.id})`);
		}
		return `<section class="chapter">\n<h1>${escapeHtml(doc.title)}</h1>\n${content || ''}\n</section>`;
	});

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(metadata.title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 42em; margin: 2em auto; line-height: 1.6; }
  .title-page { text-align: center; page-break-after: always; padding-top: 30%; }
  .title-page h1 { font-size: 2.5em; margin-bottom: 0.3em; }
  .title-page .subtitle { font-size: 1.4em; font-style: italic; margin-bottom: 2em; }
  .title-page .date { font-size: 1em; color: #666; }
  .chapter { page-break-before: always; }
  .chapter h1 { font-size: 1.8em; margin-top: 2em; margin-bottom: 1em; }
</style>
</head>
<body>
${titlePage}
${chapters.join('\n')}
</body>
</html>`;

	return { html, warnings };
}

function buildTitlePage(metadata: CompileMetadata): string {
	const subtitle = metadata.subtitle
		? `<p class="subtitle">${escapeHtml(metadata.subtitle)}</p>`
		: '';
	const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

	return `<div class="title-page">
<h1>${escapeHtml(metadata.title)}</h1>
${subtitle}
<p class="date">${date}</p>
</div>`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
