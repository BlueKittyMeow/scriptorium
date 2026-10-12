export type SaveStatus = 'saved' | 'saving' | 'unsaved';

/** Serialize saves and never acknowledge edits made while an older save was in flight. */
export class SaveQueue {
	private revision = 0;
	private savedRevision = 0;
	private inFlight: Promise<boolean> | null = null;
	constructor(
		private read: () => { content: string; docId: string },
		private save: (content: string, docId: string) => Promise<void>,
		private status: (status: SaveStatus) => void
	) {}
	markDirty() { this.revision++; this.status('unsaved'); }
	reset() { this.savedRevision = this.revision; this.status('saved'); }
	async flush(): Promise<boolean> {
		while (this.inFlight || this.savedRevision !== this.revision) {
			if (!this.inFlight) {
				const revision = this.revision;
				const { content, docId } = this.read();
				this.status('saving');
				this.inFlight = Promise.resolve().then(() => this.save(content, docId)).then(() => {
					this.savedRevision = revision;
					this.status(this.revision === revision ? 'saved' : 'unsaved');
					return true;
				}, () => { this.status('unsaved'); return false; }).finally(() => { this.inFlight = null; });
			}
			if (!(await this.inFlight)) return false;
		}
		return true;
	}
}
