import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	const pathname = url.pathname;

	// Public routes that don't require auth
	const isPublicRoute = pathname === '/login' || pathname === '/setup';

	// Check if any users exist (first-run detection)
	const userCount = locals.db
		.prepare('SELECT COUNT(*) as c FROM users')
		.get() as { c: number };

	if (userCount.c === 0 && pathname !== '/setup') {
		// No users exist — force setup
		throw redirect(302, '/setup');
	}

	if (userCount.c > 0 && pathname === '/setup') {
		// Setup already done — redirect to login
		throw redirect(302, '/login');
	}

	if (!locals.user && !isPublicRoute) {
		// Not logged in and not on a public page — redirect to login
		throw redirect(302, '/login');
	}

	if (locals.user && pathname === '/login') {
		// Already logged in — redirect to library
		throw redirect(302, '/');
	}

	return {
		user: locals.user
	};
};
