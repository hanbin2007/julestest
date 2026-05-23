"""pytest 引导：把项目根放到 sys.path，让测试能 import youdao_course / ydcore.*。"""
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
