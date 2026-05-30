-- AlterTable
ALTER TABLE "TaskHistory" ADD COLUMN "seq" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "TaskHistory_seq_key" ON "TaskHistory"("seq");

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "at" DATETIME NOT NULL
);

-- Seed 增量同步游标单例(初值 0,见方案已定默认 1:上线初无历史事件,置 0 无回灌)
INSERT INTO "SyncState" ("key", "value", "at") VALUES ('taskEventSeq', '0', CURRENT_TIMESTAMP);
