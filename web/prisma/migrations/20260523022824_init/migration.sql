-- CreateTable
CREATE TABLE "Course" (
    "productId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Video" (
    "videoId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER NOT NULL,
    "title" TEXT,
    "idx" INTEGER NOT NULL DEFAULT 0,
    "raw" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Video_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Course" ("productId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Progress" (
    "videoId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "productId" INTEGER,
    "t" REAL NOT NULL DEFAULT 0,
    "d" REAL NOT NULL DEFAULT 0,
    "title" TEXT,
    "courseName" TEXT,
    "at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" INTEGER NOT NULL,
    "t" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CacheStatus" (
    "videoId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cachedSegments" INTEGER NOT NULL DEFAULT 0,
    "totalSegments" INTEGER,
    "state" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ThumbStatus" (
    "videoId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "number" INTEGER,
    "column" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "SyncMeta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT,
    "at" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Video_productId_idx" ON "Video"("productId");

-- CreateIndex
CREATE INDEX "Note_videoId_idx" ON "Note"("videoId");
