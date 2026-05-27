-- CreateTable
CREATE TABLE "TaskHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "videoId" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TaskHistory_at_idx" ON "TaskHistory"("at");

-- CreateIndex
CREATE INDEX "TaskHistory_videoId_kind_at_idx" ON "TaskHistory"("videoId", "kind", "at");
