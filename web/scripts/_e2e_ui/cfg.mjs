// Shared constants for the isolated UI e2e harness (Theme A cache controls).
// Everything lives under an isolated /tmp workspace + alternate ports, so the
// user's live gateway(:8808)/web(:3000), prod DB(~/.youdao_course/app.db) and
// prod cache dir are NEVER touched. Zero internet: a local fake origin serves a
// tiny ffmpeg-generated HLS clip, accepted by the gateway via YD_EXTRA_ALLOWED_HOSTS.

export const ORIGIN_PORT = 18851;
export const GW_PORT = 18808;
export const WEB_PORT = 3001;

export const ROOT = "/tmp/yd_e2e_ui";
export const CACHE_DIR = `${ROOT}/cache`;
export const THUMB_DIR = `${ROOT}/thumbs`;
export const HLS_DIR = `${ROOT}/hls`;          // fake-origin document root (hd/ + ld/)
export const DB_FILE = `${ROOT}/app.db`;
export const SHOTS_DIR = "docs/superpowers/uac-shots"; // PNG evidence (per-step)

export const DATABASE_URL = `file:${DB_FILE}`;
export const GATEWAY_ORIGIN = `http://127.0.0.1:${GW_PORT}`;
export const ORIGIN_URL = `http://127.0.0.1:${ORIGIN_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const EXTRA_HOST = "127.0.0.1";          // value for YD_EXTRA_ALLOWED_HOSTS

export const PRODUCT_ID = 900001;
export const COURSE_NAME = "缓存控制验收测试课";

// Each lesson's clarity URLs point at the fake origin. duration 30s → thumbs get
// multiple frames (THUMB_INTERVAL=10s) and buffer has ~15 segments to show progress.
export const HD_URL = `${ORIGIN_URL}/hd/index.m3u8`;
export const LD_URL = `${ORIGIN_URL}/ld/index.m3u8`;
export const LESSONS = [
  { videoId: 900101, title: "第1讲 变量", contentId: 950101, cardPackageId: 960101, idx: 0, duration: 30 },
  { videoId: 900102, title: "第2讲 函数", contentId: 950102, cardPackageId: 960102, idx: 1, duration: 30 },
  { videoId: 900103, title: "第3讲 对象", contentId: 950103, cardPackageId: 960103, idx: 2, duration: 30 },
];

// ffmpeg recipe (validated): tiny real H.264 TS segments, unencrypted.
export const FFMPEG_HLS = {
  hd: { size: "640x360", rate: 10, duration: 30, hlsTime: 2 },
  ld: { size: "320x180", rate: 10, duration: 30, hlsTime: 2 },
};
