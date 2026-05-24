-- AlterTable
ALTER TABLE "Note" ADD COLUMN "productId" INTEGER;
ALTER TABLE "Note" ADD COLUMN "courseName" TEXT;
ALTER TABLE "Note" ADD COLUMN "lessonTitle" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "productId" INTEGER;

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "productId" INTEGER;

-- CreateIndex
CREATE INDEX "Note_productId_videoId_idx" ON "Note"("productId", "videoId");
