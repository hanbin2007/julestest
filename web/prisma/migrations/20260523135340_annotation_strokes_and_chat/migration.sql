-- AlterTable
ALTER TABLE "Note" ADD COLUMN "strokes" TEXT;

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "image" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ChatThread" (
    "videoId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ChatMessage_videoId_idx" ON "ChatMessage"("videoId");
