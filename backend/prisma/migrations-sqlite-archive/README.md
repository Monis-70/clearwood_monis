# Archived SQLite migration history

These sixteen migrations built the schema on SQLite across Prompts 1-10A. They are kept because
they are the project's history, not because they can be replayed: Prompt 17A moved the database to
MySQL 8 and, since there was no production data to preserve, the history was restarted from a
single consolidated migration generated from the current schema.

Do not run these. `prisma/migrations/` is the live history.
