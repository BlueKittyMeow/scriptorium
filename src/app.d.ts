import type Database from 'better-sqlite3';

declare global {
	namespace App {
		interface Locals {
			db: Database.Database;
		}
	}
}

export {};
