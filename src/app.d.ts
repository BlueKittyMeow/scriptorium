import type Database from 'better-sqlite3';
import type { User } from '$lib/types.js';

declare global {
	namespace App {
		interface Error { message: string; code?: string; }
		interface Locals {
			db: Database.Database;
			user: User | null;
		}
	}
}

export {};
