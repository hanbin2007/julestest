-- 同一讲（videoId）可被多门课打包售卖，videoId 不再全局唯一；
-- 主键改为复合 (productId, videoId)。SQLite 改主键需重建表 + 拷贝数据。
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Video" (
    "videoId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "title" TEXT,
    "idx" INTEGER NOT NULL DEFAULT 0,
    "raw" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("productId", "videoId"),
    CONSTRAINT "Video_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Course" ("productId") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Video" ("idx", "productId", "raw", "syncedAt", "title", "videoId") SELECT "idx", "productId", "raw", "syncedAt", "title", "videoId" FROM "Video";
DROP TABLE "Video";
ALTER TABLE "new_Video" RENAME TO "Video";
CREATE INDEX "Video_productId_idx" ON "Video"("productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
