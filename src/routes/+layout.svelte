<script lang="ts">
	import { onMount } from 'svelte';

	let { children, data } = $props();

	let theme = $state('system');
	let mounted = $state(false);

	async function logout() {
		await fetch('/api/auth/logout', { method: 'POST' });
		window.location.href = '/login';
	}

	const themeIcon = $derived(theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◑');
	const themeTitle = $derived(
		theme === 'dark' ? 'Dark mode (click to cycle)'
		: theme === 'light' ? 'Light mode (click to cycle)'
		: 'System theme (click to cycle)'
	);

	onMount(() => {
		theme = localStorage.getItem('scriptorium-theme') || 'system';
		mounted = true;

		// Listen for OS preference changes when in system mode
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const handler = () => {
			if (theme === 'system') {
				document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
			}
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	function cycleTheme() {
		const order = ['system', 'light', 'dark'];
		theme = order[(order.indexOf(theme) + 1) % order.length];
		try { localStorage.setItem('scriptorium-theme', theme); } catch { /* quota exceeded */ }
		if (theme === 'system') {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
		} else {
			document.documentElement.setAttribute('data-theme', theme);
		}
	}
</script>

<div class="app">
	{@render children()}
</div>

{#if mounted}
	<div class="top-bar">
		{#if data.user}
			<span class="user-info">{data.user.username} <span class="role-tag">{data.user.role}</span></span>
			{#if data.user.role === 'archivist'}
				<a href="/admin" class="admin-link">Admin</a>
			{/if}
			<button class="logout-btn" onclick={logout}>Sign Out</button>
		{/if}
		<button class="theme-toggle" onclick={cycleTheme} title={themeTitle} aria-label={themeTitle}>
			{themeIcon}
		</button>
	</div>
{/if}

<style>
	:global(:root) {
		--bg: #faf9f7;
		--bg-surface: #ffffff;
		--bg-elevated: #f5f0eb;
		--bg-sidebar: #f0ebe5;
		--bg-active: #e8e0d8;
		--bg-overlay: rgba(0, 0, 0, 0.4);

		--text: #2c2c2c;
		--text-heading: #3a2e26;
		--text-secondary: #8a7a6a;
		--text-muted: #a89a8a;
		--text-faint: #666666;
		--text-placeholder: #c8b8a8;
		--text-on-accent: #ffffff;

		--accent: #5c4a3a;
		--accent-hover: #4a3a2c;
		--accent-bg: rgba(92, 74, 58, 0.12);
		--accent-bg-strong: rgba(92, 74, 58, 0.15);

		--border: #e8e0d8;
		--border-strong: #d8d0c6;
		--border-input: #d4c8bc;
		--border-active: #c8b8a8;

		--shadow-sm: rgba(0, 0, 0, 0.06);
		--shadow-lg: rgba(0, 0, 0, 0.15);

		--tree-hover: rgba(0, 0, 0, 0.04);
		--search-highlight: #ffe066;
		--error-bg: #fef2f2;
		--error-text: #cc4444;
		--warning-bg: #fef3c7;
		--warning-text: #92400e;
		--success-bg: #d1fae5;
		--success-text: #065f46;
		--saved: #6a9a5a;
		--saving: #b8a040;
		--unsaved: #c87a50;
	}

	:global(:root[data-theme="dark"]) {
		--bg: #1a1612;
		--bg-surface: #241f1a;
		--bg-elevated: #2e2720;
		--bg-sidebar: #1f1b16;
		--bg-active: #3a322a;
		--bg-overlay: rgba(0, 0, 0, 0.6);

		--text: #d8d0c8;
		--text-heading: #ede5dd;
		--text-secondary: #a89888;
		--text-muted: #7a6a5a;
		--text-faint: #9a8a7a;
		--text-placeholder: #4a3a2a;
		--text-on-accent: #1a1612;

		--accent: #c8a882;
		--accent-hover: #d8b892;
		--accent-bg: rgba(200, 168, 130, 0.12);
		--accent-bg-strong: rgba(200, 168, 130, 0.18);

		--border: #332b24;
		--border-strong: #3a322a;
		--border-input: #4a4038;
		--border-active: #5a4a3a;

		--shadow-sm: rgba(0, 0, 0, 0.2);
		--shadow-lg: rgba(0, 0, 0, 0.4);

		--tree-hover: rgba(255, 255, 255, 0.04);
		--search-highlight: #8a6a20;
		--error-bg: #2a1515;
		--error-text: #e88888;
		--warning-bg: #2a2210;
		--warning-text: #e8c060;
		--success-bg: #0a2a1a;
		--success-text: #6ad8a0;
		--saved: #7aaa6a;
		--saving: #c8b050;
		--unsaved: #d88a60;
	}

	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(body) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		color: var(--text);
		background: var(--bg);
		min-height: 100vh;
	}

	:global(a) {
		color: var(--accent);
	}

	.app {
		min-height: 100vh;
	}

	.top-bar {
		position: fixed;
		top: 0;
		right: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
	}

	.user-info {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.role-tag {
		font-size: 0.7rem;
		background: var(--accent-bg);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		color: var(--text-muted);
	}

	.admin-link {
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-decoration: none;
	}
	.admin-link:hover { text-decoration: underline; }

	.logout-btn {
		font-size: 0.75rem;
		background: none;
		border: 1px solid var(--border-input);
		border-radius: 3px;
		color: var(--text-secondary);
		padding: 0.15rem 0.4rem;
		cursor: pointer;
	}
	.logout-btn:hover { background: var(--bg-elevated); }

	.theme-toggle {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		border: 1px solid var(--border-input);
		background: var(--bg-surface);
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0.6;
		transition: opacity 0.15s, background 0.15s;
	}

	.theme-toggle:hover {
		opacity: 1;
		background: var(--bg-elevated);
	}
</style>
