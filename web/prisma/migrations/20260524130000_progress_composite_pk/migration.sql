-- 同一讲（videoId）可被多门课打包售卖，videoId 不再全局唯一；
-- Progress 主键改为复合 (productId, videoId)，否则两门课共享同一 videoId 时后写者会在 DB 层覆盖前者（丢进度）。
-- SQLite 改主键需重建表 + 拷贝数据；productId 由可空升为 NOT NULL，重建前先回填：
--   优先用「实际拥有该讲的课」(Video 里 videoId 对应的最小 productId)，查不到（孤儿进度）用哨兵 -1。
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Progress" (
    "videoId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "t" REAL NOT NULL DEFAULT 0,
    "d" REAL NOT NULL DEFAULT 0,
    "title" TEXT,
    "courseName" TEXT,
    "at" DATETIME NOT NULL,

    PRIMARY KEY ("productId", "videoId")
);
INSERT INTO "new_Progress" ("videoId", "productId", "t", "d", "title", "courseName", "at") SELECT "videoId", COALESCE("productId", (SELECT MIN(v."productId") FROM "Video" v WHERE v."videoId" = "Progress"."videoId"), -1), "t", "d", "title", "courseName", "at" FROM "Progress";
DROP TABLE "Progress";
ALTER TABLE "new_Progress" RENAME TO "Progress";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
