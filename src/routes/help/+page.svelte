<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ROADMAP, type RoadmapItem } from '$lib/roadmap-data.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// data.user comes from the root +layout.server.ts load (no +page.server.ts
	// of our own — the guide itself stays static; only the Requests &
	// Questions and Roadmap tabs fetch, client-side, after mount).
	const isArchivist = $derived(data.user?.role === 'archivist');

	type Tab = 'guide' | 'roadmap' | 'requests';

	// A hash into the guide (e.g. /help#snapshots) always means the Guide
	// tab, scrolled to that section — checked before ?tab= so a stale query
	// param can never fight a real anchor link. The fragment is never sent to
	// the server, so page.url.hash reads empty during SSR (falling through to
	// ?tab=, which SSRs correctly) and only takes effect once the client has
	// the full URL — at which point the default 'guide' is what the browser's
	// native hash-scroll needs anyway, so there's nothing to flicker.
	function initialTab(): Tab {
		if (page.url.hash) return 'guide';
		const t = page.url.searchParams.get('tab');
		return t === 'roadmap' || t === 'requests' ? t : 'guide';
	}
	let activeTab = $state<Tab>(initialTab());

	function selectTab(tab: Tab) {
		activeTab = tab;
		if (!browser) return;
		const url = new URL(location.href);
		url.hash = '';
		if (tab === 'guide') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		goto(`${url.pathname}${url.search}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// ─── Roadmap ────────────────────────────────────────────────────
	const ROADMAP_GROUPS: { status: RoadmapItem['status']; heading: string }[] = [
		{ status: 'shipped', heading: 'Recently shipped' },
		{ status: 'next', heading: 'Up next' },
		{ status: 'planned', heading: 'Planned' },
		{ status: 'someday', heading: 'Someday / ideas' }
	];
	function itemsFor(status: RoadmapItem['status']) {
		return ROADMAP.filter((i) => i.status === status);
	}
	function formatShipped(ym?: string) {
		if (!ym) return '';
		const [y, m] = ym.split('-');
		const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
		return `${months[Number(m) - 1]} ${y}`;
	}

	// Hearts ("I want this sooner"). Loaded lazily when the Roadmap tab is
	// first opened; toggling refetches rather than trying to keep an
	// optimistic local count in sync with other people's hearts.
	let heartRows = $state<{ item_key: string; user_id: string; username: string }[]>([]);
	let heartsLoaded = $state(false);
	let heartBusy = $state<Record<string, boolean>>({});

	async function loadHearts() {
		try {
			const res = await fetch('/api/roadmap/hearts');
			if (res.ok) heartRows = await res.json();
		} finally {
			heartsLoaded = true;
		}
	}
	function heartCount(key: string) {
		return heartRows.filter((r) => r.item_key === key).length;
	}
	function heartedByMe(key: string) {
		return heartRows.some((r) => r.item_key === key && r.user_id === data.user?.id);
	}
	async function toggleHeart(key: string) {
		if (heartBusy[key]) return;
		heartBusy[key] = true;
		try {
			const res = await fetch('/api/roadmap/hearts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key })
			});
			if (res.ok) await loadHearts();
		} finally {
			heartBusy[key] = false;
		}
	}

	// ─── Requests & Questions (feedback) ───────────────────────────
	interface FeedbackItem {
		id: string;
		author_id: string;
		author_username: string;
		type: 'feature' | 'bug' | 'question';
		title: string;
		body: string | null;
		status: string;
		response: string | null;
		created_at: string;
		updated_at: string;
	}

	// Mirrors src/lib/server/validate.ts's FEEDBACK_TYPES/FEEDBACK_STATUSES —
	// a client component can't import from $lib/server, so the vocabulary is
	// duplicated here, same convention as NOVEL_STATUSES in the library page.
	const FEEDBACK_TYPE_OPTIONS: { value: FeedbackItem['type']; label: string }[] = [
		{ value: 'feature', label: 'Feature request' },
		{ value: 'bug', label: 'Bug report' },
		{ value: 'question', label: 'Question' }
	];
	const FEEDBACK_STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined', 'answered'];

	function typeLabel(type: string) {
		return FEEDBACK_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
	}
	function statusLabel(status: string) {
		return status.replace(/-/g, ' ');
	}
	function formatDate(iso: string) {
		return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	let feedbackItems = $state<FeedbackItem[]>([]);
	let feedbackLoaded = $state(false);
	let feedbackLoading = $state(false);
	let feedbackError = $state('');

	async function loadFeedback() {
		feedbackLoading = true;
		feedbackError = '';
		try {
			const res = await fetch('/api/feedback');
			if (!res.ok) throw new Error('failed');
			feedbackItems = await res.json();
			feedbackLoaded = true;
			// Seed the archivist inline-edit state for any newly-seen item so
			// the status select/response textarea start at the current values
			// (done here, not in the template, to avoid mutating state mid-render).
			for (const item of feedbackItems) {
				if (!(item.id in editStatus)) editStatus[item.id] = item.status;
				if (!(item.id in editResponse)) editResponse[item.id] = item.response ?? '';
			}
		} catch {
			feedbackError = "Couldn't load requests — try again in a moment.";
		} finally {
			feedbackLoading = false;
		}
	}

	// Submit form
	let newType = $state<FeedbackItem['type']>('feature');
	let newTitle = $state('');
	let newBody = $state('');
	let submitting = $state(false);
	let submitError = $state('');

	async function submitFeedback(e: Event) {
		e.preventDefault();
		if (!newTitle.trim() || submitting) return;
		submitting = true;
		submitError = '';
		try {
			const res = await fetch('/api/feedback', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: newType, title: newTitle.trim(), body: newBody.trim() || undefined })
			});
			if (!res.ok) throw new Error('failed');
			newTitle = '';
			newBody = '';
			newType = 'feature';
			await loadFeedback();
		} catch {
			submitError = "Couldn't send that — try again in a moment.";
		} finally {
			submitting = false;
		}
	}

	// Archivist inline edit: status select + response textarea per item.
	let editStatus = $state<Record<string, string>>({});
	let editResponse = $state<Record<string, string>>({});
	let savingId = $state<string | null>(null);

	async function saveItem(item: FeedbackItem) {
		savingId = item.id;
		try {
			await fetch(`/api/feedback/${item.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					status: editStatus[item.id] ?? item.status,
					response: editResponse[item.id]?.trim() ? editResponse[item.id] : null
				})
			});
			await loadFeedback();
		} finally {
			savingId = null;
		}
	}

	// Writer reply-on-question: sets response + status: 'answered'.
	let replyOpenFor = $state<string | null>(null);
	let replyDrafts = $state<Record<string, string>>({});

	async function sendReply(item: FeedbackItem) {
		const text = replyDrafts[item.id]?.trim();
		if (!text) return;
		await fetch(`/api/feedback/${item.id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'answered', response: text })
		});
		replyOpenFor = null;
		await loadFeedback();
	}

	$effect(() => {
		if (activeTab === 'roadmap' && !heartsLoaded) loadHearts();
		if (activeTab === 'requests' && !feedbackLoaded && !feedbackLoading) loadFeedback();
	});
</script>

<svelte:head>
	<title>User Guide — Scriptorium</title>
</svelte:head>

<div class="help-page">
	<header class="help-header">
		<a href="/" class="back-link">&larr; Library</a>
		<h1>User Guide</h1>
		<p class="subtitle">How Scriptorium works, from first novel to finished export</p>
	</header>

	<nav class="tabs" aria-label="Help sections">
		<button class:active={activeTab === 'guide'} onclick={() => selectTab('guide')}>Guide</button>
		<button class:active={activeTab === 'roadmap'} onclick={() => selectTab('roadmap')}>Roadmap</button>
		<button class:active={activeTab === 'requests'} onclick={() => selectTab('requests')}>Requests &amp; Questions</button>
	</nav>

{#if activeTab === 'guide'}
	<nav class="toc" aria-label="Table of contents">
		<h2>Contents</h2>
		<ul>
			<li><a href="#library">The Library</a></li>
			<li><a href="#shelves">Shelves &amp; Universes</a></li>
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
			showing its title, status, and word count. Novels are grouped onto shelves
			(a universe, an era, or just <em>Unsorted</em>) — see <em>Shelves &amp;
			Universes</em> below for how that grouping works.
		</p>
		<ul>
			<li><strong>Create a novel:</strong> click <em>New Novel</em>, type a title, and press Enter (or click Create). You'll land straight in the new novel's workspace.</li>
			<li><strong>Open a novel:</strong> click its card.</li>
			<li><strong>Rename a novel:</strong> hover over its card and click the ✎ pencil that appears next to the title. Press Enter to save, Escape to cancel. (You can also rename from inside the workspace — double-click the title at the top of the binder.)</li>
		</ul>
		<p>
			If novels in your library belong to more than one person, a row of filter chips
			appears above the shelves — <em>All</em>, <em>Mine</em>, and one per owner. Your
			choice is remembered between visits.
		</p>
	</section>

	<section id="shelves">
		<h2>Shelves &amp; Universes</h2>
		<p>
			As your library grows, novels can be grouped onto shelves — handy if you write
			in one big shared universe (the way Sanderson's Cosmere holds Mistborn Era 1,
			Era 2, and so on) or just want to keep a themed set, like all your poetry,
			together.
		</p>
		<ul>
			<li><strong>Universes and eras:</strong> a top-level shelf — a "universe," or simply a themed shelf like <em>Poetry</em> — can hold novels directly, plus smaller era sub-shelves nested one level inside it. Click a shelf header's chevron (▸/▾) to collapse or expand it; universes and their eras collapse independently, and Scriptorium remembers what you had open between visits.</li>
			<li><strong>Version stacks:</strong> novels that are different versions of the same book cluster into one stack on their shelf — a few card edges peeking out behind a front card, with a chip reading something like <em>"Away, Away — 3 versions."</em> Tap the stack to fan it out into individual cards; tap the chip again to collapse it back. The front card is always whichever version was updated most recently.</li>
			<li><strong>Moving a novel:</strong> on a desktop, drag a card and drop it onto any shelf header — a universe or an era — to move it there. On a phone, or anywhere you'd rather not drag, open the card's <strong>⋯</strong> menu and choose <em>Move to…</em>, then pick the destination shelf (or <em>Unsorted</em>) from the list.</li>
			<li><strong>Stacking and unstacking:</strong> the same <strong>⋯</strong> menu has a <em>Stack…</em> section — pick an existing stack label already used on that shelf, or type a new one, to group the novel into a stack. <em>Clear stack</em> pulls it back out on its own.</li>
			<li><strong>Managing shelves:</strong> click <em>Edit shelves</em> above the library to create shelves (with an optional parent, to nest an era under a universe), rename them, reorder them with the ↑/↓ arrows, or delete them. Deleting a shelf never deletes the novels on it — they simply fall to <em>Unsorted</em>, and any eras nested under a deleted universe are promoted to shelves of their own.</li>
			<li><strong>Unsorted:</strong> novels that haven't been put on a shelf yet — including every new or freshly imported novel — collect in a trailing <em>Unsorted</em> section, shown only when it has something in it.</li>
		</ul>
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
			It works exactly the same by tap on a phone — the toolbar just wraps onto a
			second row when the screen's too narrow to fit everything in one line.
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
			<li>Curious what's coming? See the <em>Roadmap</em> tab. Something broken or missing? <em>Requests &amp; Questions</em>.</li>
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

{:else if activeTab === 'roadmap'}
	<div class="roadmap-tab">
		<p class="tab-intro">
			What's shipped, what's next, and what's just an idea so far — heart
			anything you'd like to see sooner.
		</p>
		{#each ROADMAP_GROUPS as group (group.status)}
			{@const items = itemsFor(group.status)}
			{#if items.length > 0}
				<section class="roadmap-group">
					<h2>{group.heading}</h2>
					<ul class="roadmap-list">
						{#each items as item (item.key)}
							<li class="roadmap-item">
								<div class="roadmap-item-head">
									<span class="roadmap-title">{item.title}</span>
									<span class="roadmap-chip roadmap-chip-{item.status}">
										{item.status === 'shipped' ? formatShipped(item.shipped) : group.heading}
									</span>
								</div>
								{#if item.note}<p class="roadmap-note">{item.note}</p>{/if}
								{#if item.status !== 'shipped'}
									<button
										class="heart-btn"
										class:hearted={heartedByMe(item.key)}
										disabled={heartBusy[item.key]}
										onclick={() => toggleHeart(item.key)}
										aria-pressed={heartedByMe(item.key)}
										title="I want this sooner"
									>
										<span class="heart-icon">{heartedByMe(item.key) ? '♥' : '♡'}</span>
										<span class="heart-count">{heartCount(item.key)}</span>
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}
	</div>
{:else if activeTab === 'requests'}
	<div class="requests-tab">
		<form class="feedback-form" onsubmit={submitFeedback}>
			<h2>Tell us something</h2>
			<div class="form-row">
				<label>
					Type
					<select bind:value={newType}>
						{#each FEEDBACK_TYPE_OPTIONS as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</label>
			</div>
			<div class="form-row">
				<label>
					Title
					<input type="text" bind:value={newTitle} maxlength="200" placeholder="Short summary" required />
				</label>
			</div>
			<div class="form-row">
				<label>
					Details <span class="optional">(optional)</span>
					<textarea bind:value={newBody} rows="3" placeholder="Anything else that would help"></textarea>
				</label>
			</div>
			{#if submitError}<p class="form-error">{submitError}</p>{/if}
			<button type="submit" disabled={submitting || !newTitle.trim()}>
				{submitting ? 'Sending…' : 'Send'}
			</button>
		</form>

		<div class="feedback-list">
			{#if feedbackLoading}
				<p class="feedback-status">Loading…</p>
			{:else if feedbackError}
				<p class="feedback-status feedback-status-error">{feedbackError}</p>
			{:else if feedbackItems.length === 0}
				<p class="empty-state">Nothing here yet — found a bug or wish something existed? Tell us above.</p>
			{:else}
				{#each feedbackItems as item (item.id)}
					<div class="feedback-item">
						<div class="feedback-item-head">
							<span class="type-badge type-badge-{item.type}">{typeLabel(item.type)}</span>
							<span class="status-chip status-chip-{item.status}">{statusLabel(item.status)}</span>
						</div>
						<h3>{item.title}</h3>
						{#if item.body}<p class="feedback-body">{item.body}</p>{/if}
						<p class="feedback-meta">{item.author_username} · {formatDate(item.created_at)}</p>
						{#if item.response}
							<blockquote class="feedback-response">{item.response}</blockquote>
						{/if}

						{#if isArchivist}
							<div class="archivist-controls">
								<label>
									Status
									<select class="status-select" bind:value={editStatus[item.id]}>
										{#each FEEDBACK_STATUSES as s (s)}
											<option value={s}>{statusLabel(s)}</option>
										{/each}
									</select>
								</label>
								<textarea
									bind:value={editResponse[item.id]}
									rows="2"
									placeholder="Write a reply…"
								></textarea>
								<button onclick={() => saveItem(item)} disabled={savingId === item.id}>
									{savingId === item.id ? 'Saving…' : 'Save'}
								</button>
							</div>
						{:else if item.type === 'question'}
							<div class="reply-affordance">
								{#if replyOpenFor === item.id}
									<textarea bind:value={replyDrafts[item.id]} rows="2" placeholder="Your reply…"></textarea>
									<button onclick={() => sendReply(item)}>Send reply</button>
									<button class="cancel-btn" onclick={() => (replyOpenFor = null)}>Cancel</button>
								{:else}
									<button class="reply-btn" onclick={() => { replyOpenFor = item.id; replyDrafts[item.id] = ''; }}>
										Reply
									</button>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}
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

	/* Tab nav — same idiom as the admin panel's .tabs (src/routes/admin/+page.svelte). */
	.tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--border);
		margin-bottom: 2rem;
	}

	.tabs button {
		padding: 0.5rem 1rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.tabs button.active {
		color: var(--text-heading);
		border-bottom-color: var(--accent);
	}

	.tabs button:hover {
		color: var(--text);
	}

	@media (max-width: 600px) {
		.tabs {
			overflow-x: auto;
			flex-wrap: nowrap;
		}

		.tabs button {
			flex: 0 0 auto;
		}
	}

	/* ─── Roadmap tab ────────────────────────────────────────────── */

	.tab-intro {
		color: var(--text-secondary);
		font-style: italic;
		margin-bottom: 2rem;
	}

	.roadmap-group {
		margin-bottom: 2rem;
	}

	.roadmap-group h2 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text-heading);
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.35rem;
		margin-bottom: 0.75rem;
	}

	.roadmap-list {
		list-style: none;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.roadmap-item {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.roadmap-item-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.roadmap-title {
		font-weight: 600;
		color: var(--text-heading);
	}

	.roadmap-note {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin: 0.35rem 0 0;
	}

	.roadmap-chip {
		font-size: 0.7rem;
		white-space: nowrap;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
	}

	.roadmap-chip-shipped {
		color: var(--success-text);
		background: var(--success-bg);
	}

	.roadmap-chip-next {
		color: var(--warning-text);
		background: var(--warning-bg);
	}

	.roadmap-chip-planned,
	.roadmap-chip-someday {
		color: var(--text-muted);
		background: var(--accent-bg);
	}

	.heart-btn {
		margin-top: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		background: none;
		border: 1px solid var(--border-input);
		border-radius: 999px;
		padding: 0.15rem 0.6rem;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.heart-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.heart-btn.hearted {
		color: var(--accent);
		border-color: var(--accent);
		background: var(--accent-bg);
	}

	.heart-icon {
		font-size: 1rem;
	}

	/* ─── Requests & Questions tab ──────────────────────────────── */

	.feedback-form {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.25rem;
		margin-bottom: 2rem;
	}

	.feedback-form h2 {
		font-size: 1.1rem;
		color: var(--text-heading);
		margin-bottom: 0.75rem;
	}

	.form-row {
		margin-bottom: 0.75rem;
	}

	.form-row label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.form-row .optional {
		color: var(--text-muted);
		font-weight: normal;
	}

	.feedback-form select,
	.feedback-form input,
	.feedback-form textarea,
	.archivist-controls select,
	.archivist-controls textarea,
	.reply-affordance textarea {
		background: var(--bg);
		border: 1px solid var(--border-input);
		border-radius: 4px;
		color: var(--text);
		padding: 0.4rem 0.5rem;
		font-size: 16px;
		font-family: inherit;
	}

	.feedback-form button,
	.archivist-controls button,
	.reply-affordance button {
		background: var(--accent);
		color: var(--text-on-accent);
		border: none;
		border-radius: 4px;
		padding: 0.4rem 0.9rem;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.feedback-form button:disabled,
	.archivist-controls button:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.form-error {
		color: var(--error-text);
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
	}

	.feedback-status {
		color: var(--text-secondary);
	}

	.feedback-status-error {
		color: var(--error-text);
	}

	.empty-state {
		color: var(--text-secondary);
		font-style: italic;
	}

	.feedback-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.feedback-item {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1rem 1.25rem;
	}

	.feedback-item h3 {
		color: var(--text-heading);
		margin: 0.4rem 0;
	}

	.feedback-item-head {
		display: flex;
		gap: 0.5rem;
	}

	.type-badge {
		font-size: 0.7rem;
		padding: 0.1rem 0.4rem;
		border-radius: 3px;
		background: var(--accent-bg);
		color: var(--text-muted);
	}

	.status-chip {
		font-size: 0.7rem;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		background: var(--accent-bg);
		color: var(--text-muted);
	}

	.status-chip-open {
		background: var(--accent-bg);
		color: var(--accent);
	}

	.status-chip-planned,
	.status-chip-in-progress {
		background: var(--warning-bg);
		color: var(--warning-text);
	}

	.status-chip-done,
	.status-chip-answered {
		background: var(--success-bg);
		color: var(--success-text);
	}

	.status-chip-declined {
		background: var(--error-bg);
		color: var(--error-text);
	}

	.feedback-body {
		line-height: 1.5;
	}

	.feedback-meta {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.feedback-response {
		margin: 0.5rem 0 0;
		padding: 0.5rem 0.75rem;
		border-left: 3px solid var(--accent);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-style: italic;
	}

	.archivist-controls,
	.reply-affordance {
		margin-top: 0.75rem;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.archivist-controls label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.archivist-controls textarea,
	.reply-affordance textarea {
		flex: 1 1 200px;
		min-width: 160px;
	}

	.reply-btn,
	.cancel-btn {
		background: none;
		border: 1px solid var(--border-input);
		color: var(--text-secondary);
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
