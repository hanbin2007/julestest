"""三档流量优先级闸门。

0=LIVE(观看) > 1=AUTO(自动缓存) > 2=MANUAL(手动缓存)。某档回源前先 acquire(档)：
只等更高档活跃或在 grace，自己永不被同/低档挡。这样观看永远抢先，自动缓存其次，
手动缓存只在更高档空闲时才用带宽。
"""
import threading
import time

from ydcore import httpio

# 每档"活跃"后再静默这么久，挡住更低档抢这台机器有限的下行带宽。
#   LIVE 1.5：观看分片成簇到达，静默稍长，簇间不让后台插进来。
#   AUTO 0.5：预缓存循环很紧，段间空隙极小；>0 才能保证"当前这集自动补完前手动不抢"。
#   MANUAL 0：其下无更低档，无需 grace。
PRI_GRACE = {0: 1.5, 1: 0.5, 2: 0.0}


class PriorityGate:
    """按优先级档位串行化回源带宽。线程安全。"""

    def __init__(self, grace=None):
        self.grace = dict(grace) if grace else dict(PRI_GRACE)
        self.cond = threading.Condition()
        self.n = {0: 0, 1: 0, 2: 0}        # 各档在途回源数
        self.until = {0: 0.0, 1: 0.0, 2: 0.0}  # 各档活跃后的 grace 截止时刻

    def acquire(self, t):
        with self.cond:
            # wait 与自增同一临界区：避免 wait 后、自增前被更高档插队（TOCTOU）。
            while any(self.n[h] > 0 or time.time() < self.until[h] for h in range(t)):
                self.cond.wait(0.2)     # grace 靠时钟到期，必须超时轮询
            self.n[t] += 1

    def release(self, t):
        with self.cond:
            self.n[t] -= 1
            self.until[t] = time.time() + self.grace[t]
            self.cond.notify_all()

    def fetch(self, t, hdrs, url, range_header=None):
        """按优先级档位回源；try/finally 保证档计数永不泄漏。"""
        self.acquire(t)
        try:
            return httpio.upstream_fetch(hdrs, url, range_header)
        finally:
            self.release(t)
