# Multi-Tenancy Design Notes

Status: **Design notes only — not yet implemented.**
These capture the tension between our current deployment model and where the product likely needs to go.

---

## Two Deployment Models

### 1. Shared Instance (current)

Lara runs the server. Kyla writes. Lara manages deletions, backups, user accounts.

- One archivist, one or more writers
- The admin panel is useful: user management, trash, storage, audit log
- Archivist sees all novels across all users (this is the point)
- Writers trust the archivist with their data

### 2. Personal Instance (future)

An individual writer runs Scriptorium for themselves. They are both the writer and the archivist.

- One person, one account
- The admin panel is irrelevant — there are no "other users" to manage
- The writer/archivist distinction is meaningless; it's just "my account"
- Seeing a user list of one is confusing, not helpful

---

## The Core Problem

Right now, account creation flows through the admin panel (`/admin` → Users tab → Create User). This works for the shared model where an archivist is onboarding writers.

But for personal instances:
- A new user should sign up and immediately have full access
- They shouldn't see an admin panel designed for managing other people
- The two-role system (writer/archivist) should collapse into a single experience
- There's no one to "manage" them — they manage themselves

---

## Possible Future Directions

These are ideas, not commitments. Writing them down so we don't lose the thread.

### A. Instance Mode Flag

A configuration choice at first-run setup:

- **Personal mode**: single account, no admin panel, no role distinction. Setup creates one account with full access. No user management UI.
- **Shared mode**: what we have now. Archivist creates accounts, manages the house.

The flag would live in the database or an environment variable. The admin panel, user list, and role-gating UI would only render in shared mode.

### B. Self-Registration with Isolation

For a hypothetical hosted/multi-tenant future:

- Users create their own accounts (no archivist involved)
- Each user sees only their own novels
- No admin panel unless they're a platform admin (a third role?)
- Novel data is scoped by user_id (currently novels have no owner)

This would require adding `owner_id` to the novels table and scoping every query. Significant architectural change.

### C. Keep It Simple, Document the Expectation

The most pragmatic option for now:

- Personal users just create one account at setup and ignore the admin panel
- The admin link only shows for archivists, so if there's only one account with archivist role, they see it but don't need it
- Add a note in the setup flow: "You'll be the administrator of this instance"

---

## What We Know Today

- The current system works well for the Lara-and-Kyla use case
- Novels currently have no `owner_id` — any authenticated user can see all novels
- The admin panel is a dev/operations tool, not a user-facing feature
- Self-registration doesn't exist; all accounts are created by an archivist or at first-run setup
- The `writer`/`archivist` role distinction is about access control, not data isolation

## What Would Need to Change for Data Isolation

If we ever want users who can't see each other's work:

1. Add `owner_id TEXT REFERENCES users(id)` to the `novels` table
2. Scope all novel queries with `WHERE owner_id = ?`
3. Scope document, folder, snapshot queries through their novel's owner
4. Decide what archivists can see (everything? only their own? configurable?)
5. Update the library page, workspace, search, compile, and import to respect ownership
6. Add self-registration endpoint with appropriate rate limiting

This is a significant change and should be its own phase when/if the need arises.
