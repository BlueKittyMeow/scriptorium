<svelte:head>
	<title>User Guide — Scriptorium</title>
</svelte:head>

<div class="help-page">
	<header class="help-header">
		<a href="/" class="back-link">&larr; Library</a>
		<h1>User Guide</h1>
		<p class="subtitle">How Scriptorium works, from first novel to finished export</p>
	</header>

	<nav class="toc" aria-label="Table of contents">
		<h2>Contents</h2>
		<ul>
			<li><a href="#library">The Library</a></li>
			<li><a href="#writing">Writing</a></li>
			<li><a href="#snapshots">Snapshots &amp; Comparing Versions</a></li>
			<li><a href="#search">Search</a></li>
			<li><a href="#importing">Importing</a></li>
			<li><a href="#compiling">Compiling &amp; Exporting</a></li>
			<li><a href="#trash">Trash &amp; Recovery</a></li>
			<li><a href="#tips">Tips</a></li>
			<li><a href="#archivists">For Archivists</a></li>
		</ul>
	</nav>

	<section id="library">
		<h2>The Library</h2>
		<p>
			The library is your bookshelf — every novel you have lives here as a card
			showing its title, status, and word count.
		</p>
		<ul>
			<li><strong>Create a novel:</strong> click <em>New Novel</em>, type a title, and press Enter (or click Create). You'll land straight in the new novel's workspace.</li>
			<li><strong>Open a novel:</strong> click its card.</li>
			<li><strong>Rename a novel:</strong> hover over its card and click the ✎ pencil that appears next to the title. Press Enter to save, Escape to cancel. (You can also rename from inside the workspace — double-click the title at the top of the binder.)</li>
		</ul>
		<p>
			If novels on your shelf belong to more than one person, a row of filter chips
			appears above the grid — <em>All</em>, <em>Mine</em>, and one per owner. Your
			choice is remembered between visits.
		</p>
	</section>

	<section id="writing">
		<h2>Writing</h2>

		<h3>The binder</h3>
		<p>
			The left sidebar is the binder — the outline of your novel. Folders hold
			documents (and other folders); documents hold your actual writing.
		</p>
		<ul>
			<li><strong>Add a document or folder:</strong> click <em>+ Doc</em> or <em>+ Folder</em> at the top of the binder. The + button on a folder row adds a document inside that folder.</li>
			<li><strong>Open a document:</strong> click its title. Word counts appear beside each document.</li>
			<li><strong>Reorder:</strong> drag any item and drop it above, below, or (for folders) onto another item to nest it inside.</li>
			<li><strong>Collapse the binder:</strong> click the ◀ toggle to give your text the full width. On a phone, the binder slides over the editor — tap ☰ to open it, tap a document (or the dimmed area) to close it.</li>
		</ul>

		<h3>The editor</h3>
		<p>
			The toolbar covers the essentials: bold, italic, three heading levels, bullet
			and numbered lists, block quotes, and undo/redo. The usual shortcuts work too
			(Ctrl+B, Ctrl+I, Ctrl+Z).
		</p>

		<h3>Autosave</h3>
		<p>
			Your work saves itself. A couple of seconds after you stop typing, the save
			runs automatically — watch the indicator in the bottom-right corner cycle from
			<em>Unsaved changes</em> through <em>Saving...</em> to <em>Saved</em>. Switching
			to another document or leaving the page also saves first. There is no Save
			button because you never need one.
		</p>

		<h3>Spellcheck</h3>
		<p>
			The <em>ABC</em> button at the right end of the toolbar turns your browser's
			spellcheck on or off — handy to silence the red squiggles under invented names
			and places. The footer shows the current state, and your choice is remembered.
		</p>

		<h3>Light and dark themes</h3>
		<p>
			The round button in the top-right corner cycles the theme: follow your
			system (◑), always light (☀), always dark (☾). By default Scriptorium follows
			your device's setting, switching automatically when it does.
		</p>

		<h3>Word counts</h3>
		<p>
			The live count for the current document sits in the bottom-left corner. Select
			some text and the selection's count appears in front of it. The binder shows
			per-document counts, and the library card shows the novel's total.
		</p>
	</section>

	<section id="snapshots">
		<h2>Snapshots &amp; Comparing Versions</h2>
		<p>
			A snapshot is a saved copy of a document at a moment in time. Scriptorium takes
			them automatically as you write (at most one every couple of minutes), so your
			history accumulates without you thinking about it. Nothing you write is ever
			only one version deep.
		</p>
		<ul>
			<li><strong>Take one deliberately:</strong> click <em>Snapshot</em> in the editor footer before a big revision. It's marked <em>manual</em> in the timeline.</li>
			<li><strong>Browse the timeline:</strong> click <em>Snapshots</em> in the editor footer. The panel lists every snapshot grouped by day, with its time, word count, and the change in words since the previous one.</li>
			<li><strong>Preview:</strong> click a snapshot entry to read that version, read-only, exactly as it was. Click <em>Back to current</em> to return.</li>
			<li><strong>Compare:</strong> click the ⇄ icon next to a snapshot to see a word-level comparison between that snapshot (A) and your current text (B). Added words show in green; removed words show in red with a strikethrough. If nothing changed, you'll see an <em>Identical</em> badge.</li>
			<li><strong>Restore:</strong> from a preview or comparison, click <em>Restore this version</em>. You'll be asked to confirm — and your current text is saved as a snapshot first (labelled <em>pre-restore</em>), so restoring never loses anything. You can always restore back.</li>
		</ul>
		<p>
			Snapshots labelled <em>imported</em> are alternate versions that came in with an
			import — each one shows the source filename it came from, so you can tell your
			drafts apart. Compare them against the current text the same way, with the same
			⇄ icon.
		</p>
		<p>
			To compare two whole novels — say, two imported drafts of the same book — use
			<em>Compare Drafts</em> on the library page. It matches chapters between the two,
			shows how similar each pair is, lets you view the differences, and can build a
			merged novel from your choices.
		</p>
	</section>

	<section id="search">
		<h2>Search</h2>
		<p>
			Inside a novel, click <em>Search</em> at the top of the binder (or press
			<strong>Ctrl+K</strong>) and start typing. Results appear as you type, showing
			the document title and a snippet with your words highlighted.
		</p>
		<ul>
			<li>Matching is by word beginnings — typing <em>lant</em> finds <em>lantern</em>. You don't need whole words.</li>
			<li>Click a result to jump to that document; the first match is briefly highlighted in the text so your eye lands on it.</li>
			<li>Search covers the current novel and skips anything in the trash.</li>
		</ul>
	</section>

	<section id="importing">
		<h2>Importing</h2>
		<p>Click <em>Import .scriv</em> on the library page. The dialog handles three cases:</p>

		<h3>A single Scrivener project</h3>
		<p>
			Enter the path to a <code>.scriv</code> project and click <em>Import</em>. When
			it finishes you'll see a report — documents imported, folders created, word
			count — with a button to open the new novel.
		</p>

		<h3>A folder full of Scrivener projects</h3>
		<p>
			Enter a directory path instead and click <em>Scan for Projects</em>. Scriptorium
			finds every <code>.scriv</code> inside and shows a checklist — projects it thinks
			you've already imported are flagged. Tick the ones you want and import them in
			one batch.
		</p>

		<h3>A curated bundle</h3>
		<p>
			Bundles are prepared archives of older work (manuscripts, collections, drafts
			outside Scrivener). Enter the bundle directory's path and click
			<em>Dry Run</em> — this checks everything and reports exactly what would be
			imported (documents, folders, alternate versions, word counts) <em>without
			writing anything</em>. Review the report, then click <em>Import</em> to make it
			real. Works that were already imported are skipped rather than duplicated, and
			alternate versions arrive as <em>imported</em> snapshots on their documents,
			ready to compare.
		</p>
		<p>
			If you're an archivist, each import form includes an <em>Owner</em> picker so
			you can file the imported work under the right person's shelf.
		</p>
	</section>

	<section id="compiling">
		<h2>Compiling &amp; Exporting</h2>
		<p>
			When you want a copy of the whole novel outside Scriptorium, click
			<em>Compile</em> at the top of the binder.
		</p>
		<ul>
			<li><strong>Choose a format:</strong> Word (.docx), EPUB, PDF, or Markdown.</li>
			<li><strong>Choose what's included:</strong> the checklist shows every document; untick anything you want left out (notes, outtakes). Documents with alternate versions appear as a group so you can pick which version goes in.</li>
			<li><strong>Preview</strong> opens the compiled text in a new tab so you can proofread the assembly before exporting.</li>
			<li><strong>Export</strong> builds the file and downloads it, named after your novel.</li>
		</ul>
	</section>

	<section id="trash">
		<h2>Trash &amp; Recovery</h2>
		<p>
			Scriptorium is preservation-first: nothing is ever silently destroyed.
			Clicking × on a binder item moves it to the trash — it isn't deleted, just set
			aside. Trashing a folder sets aside everything inside it too.
		</p>
		<ul>
			<li>The <em>Trash</em> section at the bottom of the binder lists everything you've trashed in this novel.</li>
			<li>Click ↩ next to any item to put it back exactly where it was, contents and all.</li>
			<li>Trashed documents keep their full snapshot history, and they're excluded from search and compile until restored.</li>
		</ul>
		<p>
			Only an archivist can permanently remove something, deliberately, from the admin
			panel — and even that asks for confirmation first. Between autosave, snapshots,
			and the trash, losing work in Scriptorium takes real effort.
		</p>
	</section>

	<section id="tips">
		<h2>Tips</h2>
		<ul>
			<li><strong>Ctrl+K</strong> opens and closes search from anywhere in the workspace.</li>
			<li>The theme follows your device's light/dark setting by default — you only need the toggle if you want to override it.</li>
			<li>Spellcheck and theme choices are remembered per browser, so your phone and your desk can each have their own setup.</li>
			<li>On a phone, the binder and snapshot panel slide over the page rather than squeezing beside it — tap the dimmed background to dismiss the binder.</li>
			<li>Take a manual snapshot before a big cut. It costs nothing, and the ⇄ compare will show you exactly what you changed afterwards.</li>
			<li>Select a passage to see its word count next to the document total in the footer.</li>
		</ul>
	</section>

	<section id="archivists">
		<h2>For Archivists</h2>
		<p>
			If you're signed in as a <strong>writer</strong>, you can stop reading — none of
			this appears in your interface. Archivists (administrators) see a few extras:
		</p>
		<ul>
			<li><strong>Owner assignment:</strong> the New Novel and import dialogs include an <em>Owner</em> picker, so work can be created or imported on someone else's behalf.</li>
			<li><strong>Owner shelves:</strong> on the library page, filter chips show each owner's novels (writers see these too when shelves are shared).</li>
			<li><strong>Admin panel</strong> (the <em>Admin</em> link in the top bar): manage users and passwords, view and restore — or permanently purge — trashed items across all novels, review storage statistics, and read the audit log of account and administrative actions.</li>
		</ul>
	</section>
</div>

<style>
	.help-page {
		max-width: 720px;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}

	.help-header {
		margin-bottom: 2rem;
	}

	.back-link {
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.85rem;
	}

	.back-link:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.help-header h1 {
		font-size: 2rem;
		font-weight: 600;
		color: var(--text-heading);
		margin-top: 0.5rem;
	}

	.subtitle {
		color: var(--text-secondary);
		font-style: italic;
		margin-top: 0.25rem;
	}

	.toc {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem 1.25rem;
		margin-bottom: 2.5rem;
	}

	.toc h2 {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.5rem;
	}

	.toc ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
	}

	.toc a {
		text-decoration: none;
		font-size: 0.9rem;
	}

	.toc a:hover {
		text-decoration: underline;
	}

	section {
		margin-bottom: 2.5rem;
		scroll-margin-top: 1rem;
	}

	section h2 {
		font-size: 1.35rem;
		font-weight: 600;
		color: var(--text-heading);
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.35rem;
		margin-bottom: 0.75rem;
	}

	section h3 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-heading);
		margin: 1.25rem 0 0.4rem;
	}

	section p {
		line-height: 1.65;
		margin-bottom: 0.75rem;
	}

	section ul {
		margin: 0 0 0.75rem 1.4rem;
	}

	section li {
		line-height: 1.65;
		margin-bottom: 0.4rem;
	}

	section em {
		color: var(--text-heading);
	}

	section code {
		background: var(--bg-elevated);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		font-size: 0.85em;
	}

	@media (max-width: 600px) {
		.help-page {
			padding: 1rem 1rem 3rem;
		}
	}
</style>
