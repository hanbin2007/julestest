-- 共享讲归属(#15): TaskHistory 加 productId。同一 videoId 可被打进多门课(共享讲),
-- 仅靠 videoId 取课程名会被「后写覆盖」(byVid)归错课。网关事件从 video_meta 盖上 productId,
-- web 按 (productId, videoId) 走 byCourseVid 取课才归属正确。
-- 可空: 存量历史行 / 网关未知 productId 的事件保持 NULL,展示侧回退 byVid。
-- AlterTable
ALTER TABLE "TaskHistory" ADD COLUMN "productId" INTEGER;
