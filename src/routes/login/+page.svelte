<script lang="ts">
	let username = $state('');
	let password = $state('');
	let errorMsg = $state('');
	let submitting = $state(false);

	async function handleLogin(e: SubmitEvent) {
		e.preventDefault();
		errorMsg = '';

		if (!username.trim() || !password) {
			errorMsg = 'Username and password are required';
			return;
		}

		submitting = true;
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: username.trim(), password })
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ message: 'Login failed' }));
				errorMsg = data.message || 'Invalid credentials';
				return;
			}

			window.location.href = '/';
		} catch {
			errorMsg = 'Network error — is the server running?';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="login-page">
	<div class="login-card">
		<h1>Scriptorium</h1>
		<p class="subtitle">Sign in to continue</p>

		<form onsubmit={handleLogin}>
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
					autocomplete="current-password"
					disabled={submitting}
				/>
			</label>

			{#if errorMsg}
				<div class="error">{errorMsg}</div>
			{/if}

			<button type="submit" disabled={submitting}>
				{submitting ? 'Signing in...' : 'Sign In'}
			</button>
		</form>
	</div>
</div>

<style>
	.login-page {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 100vh;
		padding: 2rem;
	}

	.login-card {
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
		margin-bottom: 0.25rem;
	}

	.subtitle {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin-bottom: 1.5rem;
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
