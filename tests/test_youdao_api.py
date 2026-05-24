"""ydcore/youdao_api 纯逻辑函数行为锁定测试。"""
import logging
import pytest

from ydcore.youdao_api import api_headers, _walk_live, find_video


# ---- api_headers：User-Agent 大小写无关去重 ---------------------------------

def test_api_headers_keeps_lowercase_user_agent_from_session():
    """session 里已有小写 user-agent 时，结果中只出现一个 UA，且是 session 的值。"""
    session = {"user-agent": "SomeApp/1.0", "cookie": "x=1"}
    out = api_headers(session)
    # 大小写无关只有一个 UA 键
    ua_keys = [k for k in out if k.lower() == "user-agent"]
    assert len(ua_keys) == 1, "不应出现重复的 User-Agent 键"
    assert out[ua_keys[0]] == "SomeApp/1.0", "应保留 session 的 UA，而非覆盖为默认值"
    # 其他头不受影响
    assert out.get("Accept") == "application/json"


def test_api_headers_adds_default_user_agent_when_missing():
    """session 里没有任何 user-agent 时，应自动补上默认值。"""
    session = {"cookie": "x=1"}
    out = api_headers(session)
    ua_keys = [k for k in out if k.lower() == "user-agent"]
    assert len(ua_keys) == 1
    assert out[ua_keys[0]] == "YoudaoCourse/iPhone"


# ---- _walk_live：锁定节点不应被丢弃 -----------------------------------------

def _make_live_tree():
    """构造一棵含「可播放」和「已锁定」直播节点的假树。"""
    return {
        "subOutlines": [
            # 可播放：有 downloadUrl
            {
                "videoId": 1001,
                "id": 201,
                "cardPackageId": 301,
                "title": "第1讲",
                "downloadUrl": "https://cdn.example.com/1001.m3u8",
                "liveId": None,
                "duration": 3600,
                "startTime": "2024-01-01T10:00:00",
            },
            # 锁定：无 downloadUrl、无 liveId
            {
                "videoId": 1002,
                "id": 202,
                "cardPackageId": 302,
                "title": "第2讲（未解锁）",
                "downloadUrl": None,
                "liveId": None,
                "duration": 3600,
                "startTime": "2024-01-08T10:00:00",
            },
        ]
    }


def test_walk_live_includes_locked_node():
    """锁定节点（videoId 存在但 downloadUrl/liveId 均为空）应出现在结果里，且 locked=True。"""
    out = []
    _walk_live(_make_live_tree(), product_id=999, out=out)
    assert len(out) == 2, "可播放和锁定节点都应加入列表"
    by_vid = {v["videoId"]: v for v in out}
    assert 1001 in by_vid and 1002 in by_vid
    assert by_vid[1001]["locked"] is False
    assert by_vid[1002]["locked"] is True
    assert by_vid[1002]["kind"] == "live"
    assert by_vid[1002]["productId"] == 999


# ---- find_video：product_id 过滤 + 歧义警告 ---------------------------------

_PROD_A = {"id": 10, "name": "课程A"}
_PROD_B = {"id": 20, "name": "课程B"}

_VIDEOS_A = [
    {"videoId": 42, "contentId": 1, "cardPackageId": 100, "productId": 10,
     "title": "A第1讲", "downloadUrl": "https://cdn/42a.m3u8",
     "clarity": [], "locked": False, "module": None, "topic": None,
     "examKey": None, "duration": 1800, "kind": "vod"},
]
_VIDEOS_B = [
    {"videoId": 42, "contentId": 2, "cardPackageId": 200, "productId": 20,
     "title": "B第1讲", "downloadUrl": "https://cdn/42b.m3u8",
     "clarity": [], "locked": False, "module": None, "topic": None,
     "examKey": None, "duration": 1800, "kind": "vod"},
    {"videoId": 99, "contentId": 3, "cardPackageId": 200, "productId": 20,
     "title": "B独有讲", "downloadUrl": "https://cdn/99b.m3u8",
     "clarity": [], "locked": False, "module": None, "topic": None,
     "examKey": None, "duration": 900, "kind": "vod"},
]


def _stub_list_products(_session):
    return [_PROD_A, _PROD_B]


def _stub_get_videos(_session, product_id):
    if product_id == 10:
        return [dict(v) for v in _VIDEOS_A]
    if product_id == 20:
        return [dict(v) for v in _VIDEOS_B]
    return []


def test_find_video_with_product_id_returns_correct_product(monkeypatch):
    """product_id 指定时只返回该课程里的匹配，不受其他课程的同名 videoId 影响。"""
    monkeypatch.setattr("ydcore.youdao_api.list_products", _stub_list_products)
    monkeypatch.setattr("ydcore.youdao_api.get_product_videos", _stub_get_videos)

    v_a = find_video(None, 42, product_id=10)
    assert v_a is not None
    assert v_a["productId"] == 10
    assert v_a["title"] == "A第1讲"

    v_b = find_video(None, 42, product_id=20)
    assert v_b is not None
    assert v_b["productId"] == 20
    assert v_b["title"] == "B第1讲"


def test_find_video_with_product_id_returns_none_when_not_in_product(monkeypatch):
    """product_id 指定但该课程里没有该 videoId，应返回 None。"""
    monkeypatch.setattr("ydcore.youdao_api.list_products", _stub_list_products)
    monkeypatch.setattr("ydcore.youdao_api.get_product_videos", _stub_get_videos)

    result = find_video(None, 99, product_id=10)  # 99 只在课程B里
    assert result is None


def test_find_video_ambiguous_logs_warning(monkeypatch, caplog):
    """videoId 同时出现在多门课中且未指定 product_id 时，应打 WARNING 并返回第一条。"""
    monkeypatch.setattr("ydcore.youdao_api.list_products", _stub_list_products)
    monkeypatch.setattr("ydcore.youdao_api.get_product_videos", _stub_get_videos)

    with caplog.at_level(logging.WARNING, logger="ydcore.youdao_api"):
        result = find_video(None, 42)  # videoId=42 在两门课里都有

    assert result is not None, "应返回第一条匹配"
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings, "应发出 WARNING"
    assert "42" in warnings[0].message
    # 两个 productId 均应出现在警告消息里
    assert "10" in warnings[0].message
    assert "20" in warnings[0].message


def test_find_video_no_ambiguity_no_warning(monkeypatch, caplog):
    """videoId 只在一门课里时，不应触发 WARNING。"""
    monkeypatch.setattr("ydcore.youdao_api.list_products", _stub_list_products)
    monkeypatch.setattr("ydcore.youdao_api.get_product_videos", _stub_get_videos)

    with caplog.at_level(logging.WARNING, logger="ydcore.youdao_api"):
        result = find_video(None, 99)  # videoId=99 只在课程B里

    assert result is not None
    assert result["videoId"] == 99
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert not warnings, "无歧义时不应触发 WARNING"
