export interface User {
	id: string;
	username: string;
	role: 'writer' | 'archivist';
	created_at: string;
	updated_at: string;
}

export interface Novel {
	id: string;
	title: string;
	subtitle: string | null;
	status: string;
	word_count_target: number | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

export interface Folder {
	id: string;
	novel_id: string;
	parent_id: string | null;
	title: string;
	folder_type: string | null;
	sort_order: number;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

export interface Document {
	id: string;
	novel_id: string;
	parent_id: string | null;
	title: string;
	synopsis: string | null;
	word_count: number;
	compile_include: number;
	sort_order: number;
	last_snapshot_at: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
}

export interface Snapshot {
	id: string;
	document_id: string;
	content_path: string;
	word_count: number | null;
	reason: string;
	created_at: string;
}

export interface SnapshotSummary {
	id: string;
	document_id: string;
	word_count: number | null;
	reason: string;
	created_at: string;
}

export interface TreeNode {
	id: string;
	type: 'folder' | 'document';
	title: string;
	sort_order: number;
	folder_type?: string | null;
	word_count?: number;
	compile_include?: number;
	synopsis?: string | null;
	deleted_at: string | null;
	children: TreeNode[];
}

export interface ImportReport {
	novel_id: string;
	novel_title: string;
	docs_imported: number;
	folders_created: number;
	files_skipped: number;
	total_word_count: number;
	errors: string[];
	warnings: string[];
}

export interface ScrivProject {
	path: string;
	name: string;
	existingNovelTitle: string | null;
}

export interface ScanResult {
	directory: string;
	projects: ScrivProject[];
}

export interface BatchImportResult {
	results: (ImportReport & { path: string })[];
	summary: {
		total: number;
		succeeded: number;
		failed: number;
		total_docs: number;
		total_folders: number;
		total_words: number;
	};
}

export type CompileFormat = 'docx' | 'epub' | 'pdf' | 'markdown';

export interface CompileConfig {
	id: string;
	novel_id: string;
	name: string;
	format: CompileFormat;
	include_ids: string[] | null;
	created_at: string;
	updated_at: string;
}
