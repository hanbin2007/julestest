"""ydcore —— 有道课程网关的内部模块拆分。

把原先 youdao_course.py 单文件里的职责拆成可独立测试的小模块：
  hls        m3u8 文本改写 / 分片解析 / Range 解析（纯函数）
  httpio     上游回源 / 头转发 / 抓包请求解析（纯函数）
  cache      DiskLRU 磁盘分片缓存
  priority   三档流量优先级闸门 PriorityGate
  appconfig  应用配置与缓存目录解析
  youdao_api 课程/视频/观看状态枚举 + 播放头构造
  gateway    Gateway 状态对象 + HTTP Handler + 本地代理服务器
youdao_course.py 仅保留 CLI 入口。
"""
