-- 同一讲（videoId）可被多门课打包售卖，videoId 不再全局唯一；
-- ChatThread 主键改为复合 (productId, videoId)，否则两门课共享同一 videoId 时会串台会话/互相覆盖 sessionId。
-- 同时去掉 CacheStatus / ThumbStatus 的 AUTOINCREMENT 漂移（线上 DB 因历史 init 迁移带了 AUTOINCREMENT，
-- 而 schema.prisma 声明为普通 @id），这里重建对齐声明，保留全部行。
-- SQLite 改主键/列定义需重建表 + 拷贝数据。
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatThread" (
    "videoId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL DEFAULT 0,
    "sessionId" TEXT,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("productId", "videoId")
);
INSERT INTO "new_ChatThread" ("videoId", "productId", "sessionId", "updatedAt") SELECT "videoId", COALESCE("productId", 0), "sessionId", "updatedAt" FROM "ChatThread";
DROP TABLE "ChatThread";
ALTER TABLE "new_ChatThread" RENAME TO "ChatThread";
DROP INDEX "ChatMessage_videoId_idx";
CREATE INDEX "ChatMessage_productId_videoId_idx" ON "ChatMessage"("productId", "videoId");
CREATE TABLE "new_CacheStatus" (
    "videoId" INTEGER NOT NULL PRIMARY KEY,
    "cachedSegments" INTEGER NOT NULL DEFAULT 0,
    "totalSegments" INTEGER,
    "state" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CacheStatus" ("videoId", "cachedSegments", "totalSegments", "state", "bytes", "updatedAt") SELECT "videoId", "cachedSegments", "totalSegments", "state", "bytes", "updatedAt" FROM "CacheStatus";
DROP TABLE "CacheStatus";
ALTER TABLE "new_CacheStatus" RENAME TO "CacheStatus";
CREATE TABLE "new_ThumbStatus" (
    "videoId" INTEGER NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "number" INTEGER,
    "column" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ThumbStatus" ("videoId", "state", "url", "number", "column", "width", "height", "updatedAt") SELECT "videoId", "state", "url", "number", "column", "width", "height", "updatedAt" FROM "ThumbStatus";
DROP TABLE "ThumbStatus";
ALTER TABLE "new_ThumbStatus" RENAME TO "ThumbStatus";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
