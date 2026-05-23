"""应用配置与缓存目录解析。

config.json 刻意放在缓存目录之外：换盘/缓存目录整体丢失时配置仍在，才能据此分辨
"目录被删"(报错) 还是"首次启用"(创建)。
"""
import json
import logging
import os
import sys

_log = logging.getLogger(__name__)

# 分片缓存持久化目录：固定位置 + index.json，重启不清缓存。
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".youdao_course", "cache")
# 应用配置（缓存目录等可持久化设置）。
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".youdao_course", "config.json")


def load_config():
    """读应用配置；任何损坏都退化为空 dict，绝不让坏配置拖垮网关。"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}   # 尚未保存过配置，正常
    except Exception:  # noqa: BLE001
        _log.warning("配置文件损坏，按默认配置启动：%s", CONFIG_PATH, exc_info=True)
        return {}


def save_config(cfg):
    """原子写配置（tmp + rename），避免半截 JSON。成功返回 True。"""
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
        os.replace(tmp, CONFIG_PATH)
        return True
    except OSError:
        return False


def resolve_cache_dir(cli_dir):
    """决定本次使用的缓存目录，并处理"首次创建 / 丢失报错"。
    优先级：CLI 显式 --cache-dir > config.json > 默认。CLI 为一次性覆盖，不写回 config。
    判定依据：config.json 是否已记录该目录。
      · 已记录却不存在 → 视为被删 / 外置盘未挂：报错，绝不静默重建。
      · 未记录且不存在 → 首次启用：创建并（非 CLI 时）记录。
    返回 (cache_dir, ok)；ok=False 时缓存停用，但网关照常起，以便网页报错与改设置。
    """
    cfg = load_config()
    if cli_dir is not None:
        cache_dir = os.path.abspath(os.path.expanduser(cli_dir))
        persist_choice = False     # CLI 覆盖：一次性，不改 config
    else:
        cache_dir = os.path.abspath(os.path.expanduser(cfg.get("cacheDir") or CACHE_DIR))
        persist_choice = True
    recorded = cfg.get("cacheDir")
    known = bool(recorded) and os.path.abspath(os.path.expanduser(recorded)) == cache_dir

    if os.path.isdir(cache_dir):
        if persist_choice and not known:
            cfg["cacheDir"] = cache_dir
            save_config(cfg)
        return cache_dir, True
    if known:
        # 记录过却消失了：外置盘没挂 / 被删。报错，绝不在别处悄悄重建空缓存。
        sys.stderr.write(
            "⚠ 缓存目录丢失：%s\n"
            "  不会自动重建（可能是外置盘未挂载）。请在网页「设置」中修正，"
            "或恢复该目录后重启网关。\n" % cache_dir)
        return cache_dir, False
    # 首次启用：创建并记录
    try:
        os.makedirs(cache_dir, exist_ok=True)
        if persist_choice:
            cfg["cacheDir"] = cache_dir
            save_config(cfg)
        return cache_dir, True
    except OSError as e:
        sys.stderr.write("⚠ 无法创建缓存目录 %s：%s\n" % (cache_dir, e))
        return cache_dir, False
