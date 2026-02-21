<script lang="ts">
	let username = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let errorMsg = $state('');
	let submitting = $state(false);

	async function handleSetup(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';

		if (!username.trim()) {
			errorMsg = 'Username is required';
			return;
		}
		if (password.length < 8) {
			errorMsg = 'Password must be at least 8 characters';
			return;
		}
		if (password !== confirmPassword) {
			errorMsg = 'Passwords do not match';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/auth/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), password })
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Setup failed' }));
				errorMsg = data.message || 'Setup failed';
				return;
			}

			window.location.href = '/login';
		} catch {
			errorMsg = 'Network error — is the server running?';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="setup-page">
	<div class="setup-card">
		<h1>Welcome to Scriptorium</h1>
		<p class="subtitle">Create your account to get started. This will be the archivist account with full access.</p>

		<form onsubmit={handleSetup}>
			<label>
				<span>Username</span>
				<input
					type="text"
					bind:value={username}
					autocomplete="username"
					disabled={submitting}
				/>
			</label>

			<label>
				<span>Password</span>
				<input
					type="password"
					bind:value={password}
					autocomplete="new-password"
					disabled={submitting}
				/>
			</label>

			<label>
				<span>Confirm Password</span>
				<input
					type="password"
					bind:value={confirmPassword}
					autocomplete="new-password"
					disabled={submitting}
				/>
			</label>

			{#if errorMsg}
				<div class="error">{errorMsg}</div>
			{/if}

			<button type="submit" disabled={submitting}>
				{submitting ? 'Creating account...' : 'Create Account'}
			</button>
		</form>
	</div>
</div>

<style>
	.setup-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: 2rem;
	}

	.setup-card {
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 2.5rem;
		max-width: 400px;
		width: 100%;
		box-shadow: 0 2px 8px var(--shadow-sm);
	}

	h1 {
		color: var(--text-heading);
		font-size: 1.5rem;
		margin-bottom: 0.5rem;
	}

	.subtitle {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin-bottom: 1.5rem;
		line-height: 1.4;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	label span {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	input {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-input);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.95rem;
	}

	input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-bg);
	}

	button {
		padding: 0.6rem 1rem;
		background: var(--accent);
		color: var(--text-on-accent);
		border: none;
		border-radius: 4px;
		font-size: 0.95rem;
		cursor: pointer;
		margin-top: 0.5rem;
	}

	button:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.error {
		background: var(--error-bg);
		color: var(--error-text);
		padding: 0.5rem 0.75rem;
		border-radius: 4px;
		font-size: 0.85rem;
	}
</style>
