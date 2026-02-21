<script lang="ts">
	import type { User } from '$lib/types.js';

	// ─── State ───────────────────────────────────────────────────

	let activeTab = $state<'users' | 'trash' | 'storage' | 'audit'>('users');

	// Users
	let users = $state<User[]>([]);
	let newUsername = $state('');
	let newPassword = $state('');
	let newRole = $state<'writer' | 'archivist'>('writer');
	let userError = $state('');
	let userSuccess = $state('');

	// Trash
	let trashItems = $state<any[]>([]);
	let trashLoading = $state(false);

	// Storage
	let storageData = $state<any>(null);

	// Audit
	let auditEntries = $state<any[]>([]);
	let auditPage = $state(1);
	let auditTotal = $state(0);

	// ─── Users ───────────────────────────────────────────────────

	async function loadUsers() {
		const res = await fetch('/api/admin/users');
		if (res.ok) {
			const data = await res.json();
			users = data.users;
		}
	}

	async function createUser() {
		userError = '';
		userSuccess = '';
		if (!newUsername.trim() || newPassword.length < 8) {
			userError = 'Username required, password must be 8+ characters';
			return;
		}
		const res = await fetch('/api/admin/users', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole })
		});
		if (res.ok) {
			userSuccess = `Created ${newRole} "${newUsername.trim()}"`;
			newUsername = '';
			newPassword = '';
			await loadUsers();
		} else {
			const data = await res.json().catch(() => ({ message: 'Failed' }));
			userError = data.message || 'Failed to create user';
		}
	}

	async function changePassword(userId: string) {
		const pw = prompt('Enter new password (8+ characters):');
		if (!pw || pw.length < 8) {
			alert('Password must be at least 8 characters');
			return;
		}
		const res = await fetch(`/api/admin/users/${userId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password: pw })
		});
		if (res.ok) {
			userSuccess = 'Password changed (all sessions invalidated)';
		} else {
			const data = await res.json().catch(() => ({ message: 'Failed' }));
			userError = data.message || 'Failed to change password';
		}
	}

	async function deleteUser(userId: string, username: string) {
		if (!confirm(`Permanently delete user "${username}"? Their sessions will be destroyed.`)) return;
		const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
		if (res.ok) {
			await loadUsers();
			userSuccess = `Deleted "${username}"`;
		} else {
			const data = await res.json().catch(() => ({ message: 'Failed' }));
			userError = data.message || 'Failed to delete user';
		}
	}

	// ─── Trash ───────────────────────────────────────────────────

	async function loadTrash() {
		trashLoading = true;
		const res = await fetch('/api/admin/trash');
		if (res.ok) {
			const data = await res.json();
			trashItems = data.items;
		}
		trashLoading = false;
	}

	async function restoreItem(type: string, id: string) {
		const res = await fetch(`/api/admin/trash/${type}/${id}/restore`, { method: 'POST' });
		if (res.ok) await loadTrash();
	}

	async function purgeItem(type: string, id: string, title: string) {
		if (!confirm(`PERMANENTLY delete "${title}"? This cannot be undone.`)) return;
		const res = await fetch(`/api/admin/trash/${type}/${id}/purge`, { method: 'DELETE' });
		if (res.ok) await loadTrash();
	}

	// ─── Storage ─────────────────────────────────────────────────

	async function loadStorage() {
		const res = await fetch('/api/admin/storage');
		if (res.ok) storageData = await res.json();
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	// ─── Audit ───────────────────────────────────────────────────

	async function loadAudit(page = 1) {
		const res = await fetch(`/api/admin/audit?page=${page}&limit=50`);
		if (res.ok) {
			const data = await res.json();
			auditEntries = data.entries;
			auditPage = data.pagination.page;
			auditTotal = data.pagination.pages;
		}
	}

	// ─── Tab switching with data loading ─────────────────────────

	function switchTab(tab: typeof activeTab) {
		activeTab = tab;
		if (tab === 'users') loadUsers();
		if (tab === 'trash') loadTrash();
		if (tab === 'storage') loadStorage();
		if (tab === 'audit') loadAudit();
	}

	// Load users on mount
	$effect(() => { loadUsers(); });
</script>

<div class="admin-page">
	<header class="admin-header">
		<h1>Admin Panel</h1>
		<a href="/" class="back-link">Back to Library</a>
	</header>

	<nav class="tabs">
		<button class:active={activeTab === 'users'} onclick={() => switchTab('users')}>Users</button>
		<button class:active={activeTab === 'trash'} onclick={() => switchTab('trash')}>Trash</button>
		<button class:active={activeTab === 'storage'} onclick={() => switchTab('storage')}>Storage</button>
		<button class:active={activeTab === 'audit'} onclick={() => switchTab('audit')}>Audit Log</button>
	</nav>

	<div class="tab-content">
		{#if activeTab === 'users'}
			<section class="panel">
				<h2>Users</h2>
				<table class="data-table">
					<thead>
						<tr><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr>
					</thead>
					<tbody>
						{#each users as user}
							<tr>
								<td>{user.username}</td>
								<td><span class="role-badge" class:archivist={user.role === 'archivist'}>{user.role}</span></td>
								<td>{new Date(user.created_at).toLocaleDateString()}</td>
								<td class="actions">
									<button class="btn-sm" onclick={() => changePassword(user.id)}>Change Password</button>
									<button class="btn-sm btn-danger" onclick={() => deleteUser(user.id, user.username)}>Delete</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>

				<h3>Create User</h3>
				<div class="create-form">
					<input type="text" placeholder="Username" bind:value={newUsername} />
					<input type="password" placeholder="Password (8+ chars)" bind:value={newPassword} />
					<select bind:value={newRole}>
						<option value="writer">Writer</option>
						<option value="archivist">Archivist</option>
					</select>
					<button onclick={createUser}>Create</button>
				</div>
				{#if userError}<div class="error">{userError}</div>{/if}
				{#if userSuccess}<div class="success">{userSuccess}</div>{/if}
			</section>

		{:else if activeTab === 'trash'}
			<section class="panel">
				<h2>Trash</h2>
				{#if trashLoading}
					<p class="muted">Loading...</p>
				{:else if trashItems.length === 0}
					<p class="muted">Trash is empty</p>
				{:else}
					<table class="data-table">
						<thead>
							<tr><th>Title</th><th>Type</th><th>Novel</th><th>Deleted</th><th>Actions</th></tr>
						</thead>
						<tbody>
							{#each trashItems as item}
								<tr>
									<td>{item.title}</td>
									<td>{item.type}</td>
									<td>{item.novel_title || '—'}</td>
									<td>{new Date(item.deleted_at).toLocaleDateString()}</td>
									<td class="actions">
										<button class="btn-sm" onclick={() => restoreItem(item.type, item.id)}>Restore</button>
										<button class="btn-sm btn-danger" onclick={() => purgeItem(item.type, item.id, item.title)}>Purge</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</section>

		{:else if activeTab === 'storage'}
			<section class="panel">
				<h2>Storage</h2>
				{#if storageData}
					<div class="stats-grid">
						<div class="stat"><span class="stat-value">{storageData.novelCount}</span><span class="stat-label">Novels</span></div>
						<div class="stat"><span class="stat-value">{storageData.documentCount}</span><span class="stat-label">Documents</span></div>
						<div class="stat"><span class="stat-value">{storageData.snapshotCount}</span><span class="stat-label">Snapshots</span></div>
						<div class="stat"><span class="stat-value">{formatBytes(storageData.totalDiskUsage)}</span><span class="stat-label">Disk Usage</span></div>
					</div>

					{#if storageData.novelSnapshots?.length}
						<h3>Snapshots per Novel</h3>
						<table class="data-table">
							<thead><tr><th>Novel</th><th>Snapshots</th></tr></thead>
							<tbody>
								{#each storageData.novelSnapshots as ns}
									<tr><td>{ns.title}</td><td>{ns.snapshot_count}</td></tr>
								{/each}
							</tbody>
						</table>
					{/if}
				{:else}
					<p class="muted">Loading...</p>
				{/if}
			</section>

		{:else if activeTab === 'audit'}
			<section class="panel">
				<h2>Audit Log</h2>
				{#if auditEntries.length === 0}
					<p class="muted">No audit entries yet</p>
				{:else}
					<table class="data-table">
						<thead><tr><th>Time</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
						<tbody>
							{#each auditEntries as entry}
								<tr>
									<td>{new Date(entry.created_at).toLocaleString()}</td>
									<td>{entry.username || '—'}</td>
									<td><code>{entry.action}</code></td>
									<td>{entry.details || '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>

					{#if auditTotal > 1}
						<div class="pagination">
							<button disabled={auditPage <= 1} onclick={() => loadAudit(auditPage - 1)}>Previous</button>
							<span>Page {auditPage} of {auditTotal}</span>
							<button disabled={auditPage >= auditTotal} onclick={() => loadAudit(auditPage + 1)}>Next</button>
						</div>
					{/if}
				{/if}
			</section>
		{/if}
	</div>
</div>

<style>
	.admin-page {
		max-width: 960px;
		margin: 0 auto;
		padding: 2rem;
	}

	.admin-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
	}

	.admin-header h1 {
		color: var(--text-heading);
		font-size: 1.5rem;
	}

	.back-link {
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.back-link:hover { text-decoration: underline; }

	.tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1.5rem;
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

	.tabs button:hover { color: var(--text); }

	.panel h2 {
		color: var(--text-heading);
		font-size: 1.2rem;
		margin-bottom: 1rem;
	}

	.panel h3 {
		color: var(--text-heading);
		font-size: 1rem;
		margin-top: 1.5rem;
		margin-bottom: 0.75rem;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}

	.data-table th {
		text-align: left;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-strong);
		color: var(--text-secondary);
		font-weight: 500;
	}

	.data-table td {
		padding: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.role-badge {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 3px;
		font-size: 0.75rem;
		background: var(--accent-bg);
		color: var(--text-secondary);
	}

	.role-badge.archivist {
		background: var(--accent-bg-strong);
		color: var(--accent);
		font-weight: 500;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	.btn-sm {
		padding: 0.2rem 0.5rem;
		font-size: 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 3px;
		background: var(--bg-surface);
		color: var(--text);
		cursor: pointer;
	}
	.btn-sm:hover { background: var(--bg-elevated); }

	.btn-danger { color: var(--error-text); border-color: var(--error-text); }
	.btn-danger:hover { background: var(--error-bg); }

	.create-form {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.create-form input, .create-form select {
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.85rem;
	}

	.create-form button {
		padding: 0.4rem 0.8rem;
		background: var(--accent);
		color: var(--text-on-accent);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
	}
	.create-form button:hover { background: var(--accent-hover); }

	.error {
		background: var(--error-bg);
		color: var(--error-text);
		padding: 0.5rem 0.75rem;
		border-radius: 4px;
		font-size: 0.85rem;
		margin-top: 0.75rem;
	}

	.success {
		background: var(--success-bg);
		color: var(--success-text);
		padding: 0.5rem 0.75rem;
		border-radius: 4px;
		font-size: 0.85rem;
		margin-top: 0.75rem;
	}

	.muted { color: var(--text-muted); font-size: 0.9rem; }

	.stats-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.stat {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 1rem;
		text-align: center;
	}

	.stat-value {
		display: block;
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.stat-label {
		display: block;
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
	}

	.pagination {
		display: flex;
		align-items: center;
		gap: 1rem;
		justify-content: center;
		margin-top: 1rem;
	}

	.pagination button {
		padding: 0.3rem 0.6rem;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		background: var(--bg-surface);
		color: var(--text);
		cursor: pointer;
		font-size: 0.8rem;
	}
	.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }

	code {
		background: var(--bg-elevated);
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
		font-size: 0.8rem;
	}
</style>
