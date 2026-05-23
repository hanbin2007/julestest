"""零散进程工具。"""
import os


def which(name):
    """在 PATH 里找可执行文件，返回绝对路径或 None（替代依赖 shutil.which 的最小实现）。"""
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None
