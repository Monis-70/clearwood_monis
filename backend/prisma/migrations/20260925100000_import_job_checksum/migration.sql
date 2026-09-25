-- Import commit integrity (docs/DB_MIGRATION_PLAN.md section 4f).
--
-- Additive only: one nullable column. A commit must re-attach exactly the bytes that passed
-- validation, so the job keeps their sha256. Jobs created before this column exist have NULL and
-- must be validated again before they can be committed. utf8mb4_bin like every other digest
-- (backend/src/db/caseSensitiveColumns.ts).

-- AlterTable
ALTER TABLE `ImportJob` ADD COLUMN `fileChecksum` CHAR(64) COLLATE utf8mb4_bin NULL;
