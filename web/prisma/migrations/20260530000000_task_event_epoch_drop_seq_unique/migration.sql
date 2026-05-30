-- 任务事件加 per-boot epoch(#3): 事件行 id 改为 'evt-<epoch>-<seq>',幂等靠主键 id。
-- seq 跨 boot 会复用(epoch 区分行),旧的 TaskHistory_seq_key 唯一约束会让第二个 boot 的
-- 同 seq 行插入抛 P2002 → 整批 ingest 事务回滚 → 静默丢真终态(正是 #3 要修的 bug)。
-- 故移除 seq 唯一索引;幂等改由主键 id='evt-<epoch>-<seq>' 担保。
DROP INDEX "TaskHistory_seq_key";
