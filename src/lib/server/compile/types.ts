export type CompileFormat = 'docx' | 'epub' | 'pdf' | 'markdown';

export interface CompileDocument {
	id: string;
	title: string;
	novelId: string;
}

export interface CompileMetadata {
	title: string;
	subtitle: string | null;
}

export interface CompileResult {
	buffer: Buffer;
	mimeType: string;
	extension: string;
}

export const VALID_FORMATS: CompileFormat[] = ['docx', 'epub', 'pdf', 'markdown'];

export const FORMAT_CONFIG: Record<CompileFormat, { mimeType: string; extension: string }> = {
	docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx' },
	epub: { mimeType: 'application/epub+zip', extension: 'epub' },
	pdf: { mimeType: 'application/pdf', extension: 'pdf' },
	markdown: { mimeType: 'text/markdown', extension: 'md' }
};
