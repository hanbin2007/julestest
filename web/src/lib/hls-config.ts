// 客户端内存只放前后几分钟；整集由服务端磁盘缓存兜底。
export const HLS_CONFIG = {
  maxBufferLength: 120,
  maxMaxBufferLength: 300,
  backBufferLength: 180,
  maxBufferSize: 200 * 1000 * 1000,
  maxBufferHole: 0.5,
  startFragPrefetch: true,
  testBandwidth: false,
  fragLoadingMaxRetry: 8,
  nudgeMaxRetry: 10,
  lowLatencyMode: false,
} as const;
