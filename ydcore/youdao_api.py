"""课程 / 视频枚举 + 播放头构造。

只要会话 Cookie 就能列出全部课程和视频，不用一个个抓。目录(get_product_videos)与观看
状态(get_product_watch_state)分开：目录极少变、可长缓存；观看状态每次同步都要新鲜地拉。
"""
import json
import logging
import time
import urllib.request

_log = logging.getLogger(__name__)

API_PRODUCTS = "https://ai.ydshengxue.com/ai-product/api/app/v2/products/after-sale"
API_PRODUCT_DETAIL = "https://ai.ydshengxue.com/ai-product/api/app/v3/products/after-sale/%s"
API_VIDEO_OUTLINE = ("https://ai.ydshengxue.com/ai-product/api/app/v1/products/"
                     "videos/%s/outline?cardPackageId=%s&cardPackageContentId=%s&productId=%s")

# 调 ydshengxue API 时只需要这几个头；其余按 App 习惯补默认值
_API_HEADER_KEYS = {"cookie", "imei", "keyfrom", "user-agent"}


def api_headers(session):
    out = {}
    for k, v in session.items():
        if k.lower() in _API_HEADER_KEYS:
            out[k] = v
    # 用大小写无关检查，避免 session 里已有小写 user-agent 时再插入大写副本
    if not any(k.lower() == "user-agent" for k in out):
        out["User-Agent"] = "YoudaoCourse/iPhone"
    out.setdefault("Keyfrom", "aicard.1.4.9.ios")
    out["Accept"] = "application/json"
    out["Accept-Encoding"] = "identity"
    return out


def api_get_json(session, url, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=api_headers(session))
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001  (上游偶发抖动，退避重试)
            last = e
            _log.debug("有道 API 第 %d 次重试：%s（%s）", attempt + 1, url, e)
            time.sleep(0.6 * (attempt + 1))
    raise last


def list_products(session):
    """返回已购课程列表：[{id, name, ...}]。"""
    d = api_get_json(session, API_PRODUCTS)
    return (d.get("data") or {}).get("allProductList") or []


def _walk_outline(node, pkg_id, product_id, out):
    """递归 outline 树，收集所有视频节点。"""
    if isinstance(node, list):
        for it in node:
            _walk_outline(it, pkg_id, product_id, out)
        return
    if not isinstance(node, dict):
        return
    for v in node.get("videos") or []:
        out.append({
            "videoId": v.get("videoId"),
            "contentId": v.get("id"),
            "cardPackageId": v.get("cardPackageId") or pkg_id,
            "productId": v.get("productId") or product_id,
            "title": v.get("title"),
            "downloadUrl": v.get("downloadUrl"),
            "clarity": v.get("clarityInfoList") or [],
            "locked": not v.get("downloadUrl"),
            "module": (v.get("moduleInfo") or {}).get("title"),
            "topic": (v.get("topicInfo") or {}).get("title"),
            "examKey": (v.get("examKeyInfo") or {}).get("title"),
            "duration": v.get("duration"),
            "kind": "vod",
        })
    for key in ("subOutlines", "outlines"):
        if node.get(key):
            _walk_outline(node[key], pkg_id, product_id, out)


def _walk_live(node, product_id, out, tab=None, year=None, month=None):
    """递归直播回放 outline 树。与点播不同：直播项直接挂在 subOutlines 上（不在 videos 键下），
    自带 cardPackageId/liveId、无清晰度档（只有单条 downloadUrl），按 年/月 分组。"""
    if isinstance(node, list):
        for it in node:
            _walk_live(it, product_id, out, tab, year, month)
        return
    if not isinstance(node, dict):
        return
    y = node.get("year", year)
    m = node.get("month", month)
    # 直播项：自身带 videoId（可能未解锁，downloadUrl/liveId 均为空）；
    # 未解锁的节点仍加入列表（locked=True），与 _walk_outline 行为一致。
    if node.get("videoId"):
        out.append({
            "videoId": node.get("videoId"),
            "contentId": node.get("id"),
            "cardPackageId": node.get("cardPackageId"),
            "productId": product_id,
            "title": node.get("title"),
            "downloadUrl": node.get("downloadUrl"),
            "clarity": [],  # 直播回放无清晰度档
            "locked": not node.get("downloadUrl"),
            "module": None, "topic": None, "examKey": None,
            "duration": node.get("duration"),
            "kind": "live",
            "liveId": node.get("liveId"),  # 解密 key 接口要求的 Liveid 头来源
            "liveTab": tab,
            "year": y, "month": m,
            "startTime": node.get("startTime"),
        })
        return
    for key in ("subOutlines", "outlines"):
        if node.get(key):
            _walk_live(node[key], product_id, out, tab, y, m)


def get_product_videos(session, product_id):
    """返回某课程下所有视频（含 videoId / contentId / cardPackageId / productId / m3u8）。"""
    d = (api_get_json(session, API_PRODUCT_DETAIL % product_id).get("data") or {})
    out = []
    tab = d.get("videoPackageTab") or {}
    pkgs = tab.get("videoPackages") or []
    for pkg in pkgs:
        _walk_outline(pkg.get("outlines"), pkg.get("videoPackageId"), product_id, out)
    # 直播回放：结构与点播不同，单独走 _walk_live（项自带 cardPackageId/liveId）。
    for live in (d.get("servicePackage") or {}).get("videoLiveTab") or []:
        _walk_live(live.get("outlines"), product_id, out, tab=live.get("title"))
    return out


def _num(x):
    return x if isinstance(x, (int, float)) else 0


def _collect_watch_state(node, out):
    """递归整条 product detail，把任何带 videoId 的节点的观看字段收集出来。
    点播项挂在 videos[]、直播项挂在 subOutlines；二者都会被这棵遍历覆盖。
    有道的观看字段（每讲，无时间戳）：
      playDuration         上次播放到的位置（秒）≈ 本地 t，用于续看；是「最后位置」非「看过的最远处」
      accumulativeDuration 累计观看秒数（含重看，噪声大，仅作统计）
      videoStudyTag.study  是否已学完（完成标记，合并时以此为准）
      duration             时长（秒）
    """
    if isinstance(node, list):
        for it in node:
            _collect_watch_state(it, out)
        return
    if not isinstance(node, dict):
        return
    vid = node.get("videoId")
    if vid is not None:
        tag = node.get("videoStudyTag")
        study = bool(tag.get("study")) if isinstance(tag, dict) else False
        cur = out.get(vid)
        ws = {
            "videoId": vid,
            "playDuration": node.get("playDuration"),
            "accumulativeDuration": node.get("accumulativeDuration"),
            "duration": node.get("duration"),
            "study": study,
            "title": node.get("title"),
        }
        # 同一 videoId 偶有多处出现：合并取「更靠前/已学完」，避免空节点覆盖有值节点。
        if cur:
            ws["playDuration"] = max(_num(cur.get("playDuration")), _num(ws.get("playDuration"))) or None
            ws["accumulativeDuration"] = max(_num(cur.get("accumulativeDuration")), _num(ws.get("accumulativeDuration"))) or None
            ws["duration"] = max(_num(cur.get("duration")), _num(ws.get("duration"))) or None
            ws["study"] = bool(cur.get("study")) or study
            ws["title"] = ws["title"] or cur.get("title")
        out[vid] = ws
    for v in node.values():
        if isinstance(v, (dict, list)):
            _collect_watch_state(v, out)


def get_product_watch_state(session, product_id):
    """返回某课程下每讲的有道观看状态：{videoId: {playDuration, accumulativeDuration, duration, study, title}}。
    与目录(get_product_videos)分开：目录极少变、可长缓存；观看状态每次同步都要新鲜地拉。"""
    d = (api_get_json(session, API_PRODUCT_DETAIL % product_id).get("data") or {})
    out = {}
    _collect_watch_state(d, out)
    return list(out.values())


def find_video(session, video_id, product_id=None):
    """在所有课程里找到指定 videoId 的视频条目。

    product_id — 可选。传入时只在该课程里查找（精确匹配 productId + videoId）；
                 不传时扫全部课程，若 videoId 出现在多门课中会打 WARNING 并返回第一条。
    """
    video_id = int(video_id)
    if product_id is not None:
        product_id = int(product_id)

    if product_id is not None:
        # 精确模式：只扫目标课程
        for prod in list_products(session):
            if int(prod["id"]) != product_id:
                continue
            for v in get_product_videos(session, prod["id"]):
                if v.get("videoId") == video_id:
                    v["productName"] = prod.get("name")
                    return v
        return None

    # 模糊模式：扫全部课程，收集所有匹配项
    matches = []
    for prod in list_products(session):
        for v in get_product_videos(session, prod["id"]):
            if v.get("videoId") == video_id:
                v["productName"] = prod.get("name")
                matches.append((prod["id"], v))
    if not matches:
        return None
    if len(matches) > 1:
        prod_ids = [str(pid) for pid, _ in matches]
        _log.warning(
            "videoId=%s 在多门课中均有出现（productId: %s），返回第一条，"
            "建议用 --product 指定课程以消除歧义。",
            video_id, ", ".join(prod_ids),
        )
    return matches[0][1]


def _pick_clarity(clist, quality="highest"):
    clist = [c for c in (clist or []) if c.get("url")]
    if not clist:
        return None
    clist = sorted(clist, key=lambda c: c.get("type", 0),
                   reverse=(quality == "highest"))
    return clist[0]["url"]


def resolve_m3u8(session, video, quality="highest"):
    """拿到视频的 m3u8 地址；优先用树里自带的 clarityInfoList，再回退 downloadUrl / outline 接口。"""
    url = _pick_clarity(video.get("clarity"), quality)
    if url:
        return url
    if video.get("downloadUrl"):
        return video["downloadUrl"]
    try:
        api = API_VIDEO_OUTLINE % (video["videoId"], video["cardPackageId"],
                                   video["contentId"], video["productId"])
        infos = (api_get_json(session, api).get("data") or {}).get("videoInfos") or []
        for vi in infos:
            url = _pick_clarity(vi.get("clarityInfoList"), quality)
            if url:
                return url
    except Exception:  # noqa: BLE001
        _log.debug("outline 接口取 m3u8 失败 videoId=%s", video.get("videoId"), exc_info=True)
    return None


def play_headers(session, video, m3u8_url):
    """构造播放该视频所需的全套头（会话头 + 该视频的 Url/Videoid/Cardpackageid...）。"""
    h = dict(session)
    h.setdefault("User-Agent", "YoudaoCourse/iPhone")
    h.setdefault("Referer", "http://live.youdao.com")
    h.setdefault("Keyfrom", "aicard.1.4.9.ios")
    h["Url"] = m3u8_url
    h["Videoid"] = str(video["videoId"])
    h["Cardpackageid"] = str(video["cardPackageId"])
    h["Cardpackagecontentid"] = str(video["contentId"])
    h["Productid"] = str(video["productId"])
    # 直播回放：解密 key 接口(live.ydshengxue.com)校验课次↔url，必须带 Liveid 才返回真 AES key。
    if video.get("liveId"):
        h["Liveid"] = str(video["liveId"])
    else:
        h.pop("Liveid", None)  # 点播不要让上一个会话的 Liveid 残留
    return h
