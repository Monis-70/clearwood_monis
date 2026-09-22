-- CreateTable
CREATE TABLE "MediaFolder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "MediaFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MediaFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaId" TEXT NOT NULL,
    "usageType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaUsage_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Media" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "disk" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "url" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "source" TEXT NOT NULL DEFAULT 'ADMIN_UPLOAD',
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "checksumSha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" INTEGER,
    "altText" TEXT,
    "title" TEXT,
    "blurhash" TEXT,
    "dominantColorHex" TEXT,
    "lqipDataUri" TEXT,
    "focalPointX" INTEGER,
    "focalPointY" INTEGER,
    "isOptimized" BOOLEAN NOT NULL DEFAULT false,
    "processingError" TEXT,
    "tagsJson" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "folder" TEXT NOT NULL DEFAULT 'uploads',
    "folderId" TEXT,
    "uploadedByType" TEXT,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "Media_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MediaFolder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Media" ("altText", "blurhash", "checksum", "createdAt", "deletedAt", "disk", "durationSec", "folder", "height", "id", "kind", "mimeType", "originalName", "path", "sizeBytes", "title", "updatedAt", "uploadedById", "uploadedByType", "url", "width") SELECT "altText", "blurhash", "checksum", "createdAt", "deletedAt", "disk", "durationSec", "folder", "height", "id", "kind", "mimeType", "originalName", "path", "sizeBytes", "title", "updatedAt", "uploadedById", "uploadedByType", "url", "width" FROM "Media";
DROP TABLE "Media";
ALTER TABLE "new_Media" RENAME TO "Media";
CREATE INDEX "Media_kind_idx" ON "Media"("kind");
CREATE INDEX "Media_folder_idx" ON "Media"("folder");
CREATE INDEX "Media_folderId_idx" ON "Media"("folderId");
CREATE INDEX "Media_status_idx" ON "Media"("status");
CREATE INDEX "Media_checksumSha256_idx" ON "Media"("checksumSha256");
CREATE TABLE "new_MediaVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mediaId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "deviceTarget" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MediaVariant_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MediaVariant" ("createdAt", "format", "height", "id", "label", "mediaId", "path", "sizeBytes", "updatedAt", "width") SELECT "createdAt", "format", "height", "id", "label", "mediaId", "path", "sizeBytes", "updatedAt", "width" FROM "MediaVariant";
DROP TABLE "MediaVariant";
ALTER TABLE "new_MediaVariant" RENAME TO "MediaVariant";
CREATE INDEX "MediaVariant_mediaId_deviceTarget_idx" ON "MediaVariant"("mediaId", "deviceTarget");
CREATE UNIQUE INDEX "MediaVariant_mediaId_label_format_key" ON "MediaVariant"("mediaId", "label", "format");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MediaFolder_slug_key" ON "MediaFolder"("slug");

-- CreateIndex
CREATE INDEX "MediaFolder_parentId_position_idx" ON "MediaFolder"("parentId", "position");

-- CreateIndex
CREATE INDEX "MediaFolder_path_idx" ON "MediaFolder"("path");

-- CreateIndex
CREATE INDEX "MediaUsage_usageType_entityId_idx" ON "MediaUsage"("usageType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaUsage_mediaId_usageType_entityId_field_key" ON "MediaUsage"("mediaId", "usageType", "entityId", "field");
