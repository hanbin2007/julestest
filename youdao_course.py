#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
youdao_course.py
================
把有道听课客户端抓到的加密 HLS 流，变成可以在浏览器 / 任意播放器里看的视频。

原理
----
有道的课程是 AES-128 加密的 HLS（一个 .m3u8 播放列表 + 一堆 .ts 分片，路径里带
"/encrypt/"）。stream.youdao.com 只在请求带上那一串鉴权头时才返回内容：
    Cookie / Imei / Productid / Videoid / Cardpackageid / Cardpackagecontentid /
    Keyfrom / Referer / User-Agent ...
普通浏览器请求因为缺这些头会被拒。

本脚本起一个本地代理：浏览器里的 hls.js / Safari，或者 ffmpeg，只跟本地代理打交道；
代理负责补齐这些头、把 m3u8 里的分片/密钥地址改写成走代理、再转发上游响应。
解密用的 key 也通过代理拿（带头），所以 hls.js / ffmpeg 能正常解密。

用法
----
1) 在抓包工具里复制那条 .m3u8 请求的“原文/raw”，存成 req.txt
2) 浏览器在线看：
       python3 youdao_course.py serve --request req.txt
   打开 http://127.0.0.1:8808 ，把 m3u8 地址粘进去就能放（支持倍速 / 拖进度）。
3) 下载成 mp4（需要本机有 ffmpeg：brew install ffmpeg）：
       python3 youdao_course.py download --request req.txt \
           --url 'https://stream.youdao.com/.../xxx.m3u8' -o 课程.mp4
   不传 --url 时会用 req.txt 里那条请求自己的地址。

说明：仅用于观看你自己已购买 / 有权访问的课程，请遵守平台条款。会话(Cookie 等)会过期，
过期后重新抓一条请求覆盖 req.txt 即可。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 转发给上游时要去掉的逐跳 / 会被自动重设的头。
# 注意：故意保留 "url" —— 解密 key 的接口(live.ydshengxue.com)要求 Url 头始终指向
# m3u8 地址（App 对 m3u8 / ts / key 三种请求都带同一个 Url=<m3u8>），改写它会导致 key 返回失败。
_DROP_HEADERS = {
    "host", "connection", "proxy-connection", "content-length",
    "accept-encoding", "range", "te", "upgrade",
}

_REQUEST_LINE_RE = re.compile(r"^(GET|POST|HEAD|PUT|DELETE|OPTIONS)\s+(\S+)\s+HTTP/", re.I)
_URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


def parse_request(text):
    """从抓包复制出来的原文里解析出 (url, headers)。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    start = None
    for i, line in enumerate(lines):
        if _REQUEST_LINE_RE.match(line.strip()):
            start = i
            break
    if start is None:
        raise ValueError("没找到请求行（形如 'GET /path HTTP/1.1'）。请确认粘贴的是请求原文。")

    m = _REQUEST_LINE_RE.match(lines[start].strip())
    path = m.group(2)

    headers = {}
    for line in lines[start + 1:]:
        if line.strip() == "":
            break
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        headers[key.strip()] = val.strip()

    url = headers.get("Url") or headers.get("URL")
    if not url or not url.lower().startswith("http"):
        host = headers.get("Host")
        if not host:
            raise ValueError("缺少 Host 头，无法拼出完整地址。")
        url = "https://%s%s" % (host, path)

    return url, headers


def forward_headers(headers, range_header=None):
    """构造转发给上游的头：原样保留鉴权 / 自定义头（含 Url），去掉逐跳头。"""
    out = {}
    for key, val in headers.items():
        if key.lower() in _DROP_HEADERS:
            continue
        out[key] = val
    out["Accept-Encoding"] = "identity"
    if range_header:
        out["Range"] = range_header
    return out


def _proxify(abs_url, vid=None):
    s = "/p?u=" + urllib.parse.quote(abs_url, safe="")
    if vid:
        s += "&vid=" + urllib.parse.quote(str(vid), safe="")
    return s


def rewrite_m3u8(body_text, base_url, vid=None):
    """把 m3u8 里的分片 / 子播放列表 / 密钥地址改写成走本地代理（带上 vid 以便选对鉴权头）。"""
    out_lines = []
    for raw in body_text.splitlines():
        line = raw.strip()
        if line == "":
            out_lines.append(raw)
        elif line.startswith("#"):
            if "URI=" in raw:
                def _sub(m):
                    abs_u = urllib.parse.urljoin(base_url, m.group(1))
                    return 'URI="%s"' % _proxify(abs_u, vid)
                raw = _URI_ATTR_RE.sub(_sub, raw)
            out_lines.append(raw)
        else:
            abs_u = urllib.parse.urljoin(base_url, line)
            out_lines.append(_proxify(abs_u, vid))
    return "\n".join(out_lines) + "\n"


def _looks_like_m3u8(url, content_type):
    if content_type and "mpegurl" in content_type.lower():
        return True
    path = urllib.parse.urlparse(url).path.lower()
    return path.endswith(".m3u8") or path.endswith(".m3u")


APP_HTML = r"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>课程</title>
<style>
:root{
  --bg:#0e1116; --panel:#151a22; --panel2:#1b212b; --line:#262d39;
  --txt:#e6e9ef; --mut:#8b94a3; --accent:#4f8cff; --accent2:#6ea2ff;
  --ok:#3ecf8e; --lock:#5a6473; --shadow:0 6px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--txt);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
.app{display:grid;grid-template-columns:340px 1fr;height:100vh;overflow:hidden}
/* sidebar */
.side{background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}
.side-head{padding:16px 16px 10px;border-bottom:1px solid var(--line)}
.brand{font-size:15px;font-weight:700;letter-spacing:.3px;display:flex;align-items:center;gap:8px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
.brand .cnt{margin-left:auto;font-size:12px;color:var(--mut);font-weight:500}
.search{margin-top:10px;position:relative}
.search input{width:100%;padding:9px 12px 9px 32px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel2);color:var(--txt);font-size:13px;outline:none}
.search input:focus{border-color:var(--accent)}
.search svg{position:absolute;left:10px;top:9px;color:var(--mut)}
.list{flex:1;overflow-y:auto;padding:8px}
.list::-webkit-scrollbar{width:9px}
.list::-webkit-scrollbar-thumb{background:#2b3340;border-radius:8px;border:2px solid var(--panel)}
.course{margin-bottom:4px;border-radius:10px}
.course>.row{display:flex;align-items:center;gap:8px;padding:10px 10px;cursor:pointer;border-radius:10px;
  font-size:13.5px;font-weight:600;color:var(--txt);user-select:none}
.course>.row:hover{background:var(--panel2)}
.course .chev{transition:transform .18s;color:var(--mut);flex:0 0 auto}
.course.open .chev{transform:rotate(90deg)}
.course .ctitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{font-size:11px;color:var(--mut);background:var(--panel2);padding:2px 7px;border-radius:20px;flex:0 0 auto}
.kids{display:none;padding:2px 0 6px 6px}
.course.open>.kids{display:block}
.grp{margin:2px 0}
.grp>.ghead{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-radius:8px;
  font-size:12px;color:var(--mut);font-weight:600;user-select:none}
.grp>.ghead:hover{color:var(--txt)}
.grp .chev{transition:transform .18s;flex:0 0 auto}
.grp.open>.ghead .chev{transform:rotate(90deg)}
.grp>.gkids{display:none;padding-left:10px;border-left:1px solid var(--line);margin-left:11px}
.grp.open>.gkids{display:block}
.vid{display:flex;align-items:center;gap:9px;padding:8px 10px;margin:1px 0;border-radius:8px;cursor:pointer;
  font-size:13px;color:#cfd6e0;line-height:1.35}
.vid:hover{background:var(--panel2)}
.vid.active{background:linear-gradient(90deg,rgba(79,140,255,.18),rgba(79,140,255,.04));
  color:#fff;box-shadow:inset 3px 0 0 var(--accent)}
.vid .ic{flex:0 0 auto;color:var(--accent2)}
.vid.active .ic{color:var(--accent)}
.vid .vt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vid .dur{flex:0 0 auto;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
.vid.locked{color:var(--lock);cursor:not-allowed}
.vid.locked .ic{color:var(--lock)}
.loading,.empty{padding:14px 10px;color:var(--mut);font-size:12px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);border-top-color:var(--accent);
  border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes sp{to{transform:rotate(360deg)}}
/* main */
.main{display:flex;flex-direction:column;min-width:0;background:var(--bg)}
.topbar{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line)}
.hamb{display:none;background:none;border:none;color:var(--txt);cursor:pointer;padding:4px}
.crumb{font-size:12px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.crumb b{color:var(--txt);font-weight:600}
.stage{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;align-items:center}
.player-wrap{width:100%;max-width:1100px}
.frame{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:14px;overflow:hidden;
  box-shadow:var(--shadow)}
video{width:100%;height:100%;display:block;background:#000}
.placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  color:var(--mut);gap:10px;text-align:center;padding:20px}
.placeholder svg{opacity:.5}
.meta{max-width:1100px;width:100%;margin-top:16px}
.vtitle{font-size:19px;font-weight:700;line-height:1.4}
.vsub{margin-top:6px;color:var(--mut);font-size:13px}
.actions{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel2);color:var(--txt);font-size:13px;cursor:pointer;transition:.15s}
.btn:hover:not(:disabled){border-color:var(--accent);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent2)}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);opacity:0;
  background:#222b38;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;box-shadow:var(--shadow);
  transition:.25s;pointer-events:none;z-index:50;border:1px solid var(--line)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.scrim{display:none}
@media(max-width:860px){
  .app{grid-template-columns:1fr}
  .side{position:fixed;z-index:40;top:0;bottom:0;left:0;width:86%;max-width:360px;
    transform:translateX(-100%);transition:transform .25s;box-shadow:var(--shadow)}
  .app.drawer .side{transform:none}
  .hamb{display:inline-flex}
  .scrim{display:block;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:39;opacity:0;pointer-events:none;
    transition:.25s}
  .app.drawer .scrim{opacity:1;pointer-events:auto}
  .stage{padding:12px}
  .vtitle{font-size:17px}
}
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="side" id="side">
    <div class="side-head">
      <div class="brand"><span class="dot"></span>我的课程<span class="cnt" id="cnt"></span></div>
      <div class="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="q" placeholder="搜索讲次 / 课程…" autocomplete="off">
      </div>
    </div>
    <div class="list" id="list"><div class="loading"><span class="spin"></span>加载课程…</div></div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <main class="main">
    <div class="topbar">
      <button class="hamb" id="hamb" aria-label="menu"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      <div class="crumb" id="crumb">选择左侧任意一讲开始</div>
    </div>
    <div class="stage">
      <div class="player-wrap">
        <div class="frame">
          <video id="v" controls playsinline></video>
          <div class="placeholder" id="ph">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m10 8 6 4-6 4V8z"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg>
            <div>从左侧选择一讲开始播放</div>
          </div>
        </div>
        <div class="meta">
          <div class="vtitle" id="vtitle">—</div>
          <div class="vsub" id="vsub"></div>
          <div class="actions">
            <button class="btn" id="prev" disabled>← 上一讲</button>
            <button class="btn primary" id="next" disabled>下一讲 →</button>
            <button class="btn" id="dl">复制下载命令</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>
<div class="toast" id="toast"></div>
<script src="/hls.js"></script>
<script>
const AUTO = __AUTO__;
const $ = s => document.querySelector(s);
const el = (t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e;};
const fmtDur = s => { s=parseInt(s||0); if(!s)return''; const m=Math.floor(s/60),x=s%60; return m+':'+String(x).padStart(2,'0'); };
const esc = s => (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let courses=[], byId={}, curList=[], activeVid=null, hls=null;

function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);}
function closeDrawer(){$('#app').classList.remove('drawer');}

async function api(u){const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}

async function init(){
  try{ const d=await api('/api/courses'); courses=d.courses||[]; }
  catch(e){ $('#list').innerHTML='<div class="empty">加载课程失败：'+esc(e.message)+'<br>会话可能过期，请重新抓一条请求覆盖 req.txt。</div>'; return; }
  $('#cnt').textContent=courses.length+' 门';
  const list=$('#list'); list.innerHTML='';
  courses.forEach(c=>{ byId[c.id]=c; list.appendChild(courseEl(c)); });
  if(AUTO && AUTO.productId){ openCourse(AUTO.productId, AUTO.videoId); }
}

function courseEl(c){
  const wrap=el('div','course'); wrap.dataset.pid=c.id;
  const row=el('div','row');
  row.innerHTML='<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 6 6 6-6 6"/></svg>'
    +'<span class="ctitle">'+esc(c.name)+'</span><span class="badge">'+(c.cardType||'课程')+'</span>';
  const kids=el('div','kids'); kids.innerHTML='';
  row.onclick=()=>toggleCourse(wrap,kids,c.id);
  wrap.appendChild(row); wrap.appendChild(kids);
  return wrap;
}

async function toggleCourse(wrap,kids,pid){
  if(wrap.classList.contains('open')){ wrap.classList.remove('open'); return; }
  wrap.classList.add('open');
  if(kids.dataset.loaded) return;
  kids.innerHTML='<div class="loading"><span class="spin"></span>加载讲次…</div>';
  try{
    const d=await api('/api/course?productId='+encodeURIComponent(pid));
    kids.dataset.loaded='1';
    renderVideos(kids, d.videos||[], pid);
  }catch(e){ kids.innerHTML='<div class="empty">加载失败：'+esc(e.message)+'</div>'; }
}

function renderVideos(kids, vids, pid){
  byId[pid]._vids=vids;
  if(!vids.length){ kids.innerHTML='<div class="empty">这门课暂无视频</div>'; return; }
  kids.innerHTML='';
  // 按 module → topic → examKey 分组，保持顺序
  const tree=[], idx={}, rootVids=[];
  vids.forEach(v=>{
    const path=[v.module,v.topic,v.examKey].filter(x=>x);
    if(!path.length){ rootVids.push(v); return; }
    let level=tree, key='', node=null;
    path.forEach(p=>{ key+='|'+p;
      if(!idx[key]){ node={name:p,kids:[],vids:[]}; idx[key]=node; level.push(node); }
      node=idx[key]; level=node.kids; });
    node.vids.push(v);
  });
  rootVids.forEach(v=>kids.appendChild(vidEl(v,pid)));
  tree.forEach(n=>kids.appendChild(groupEl(n,pid)));
}

function groupEl(n,pid){
  const g=el('div','grp open');
  const h=el('div','ghead');
  h.innerHTML='<svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 6 6 6-6 6"/></svg><span>'+esc(n.name)+'</span>';
  const gk=el('div','gkids');
  n.kids.forEach(c=>gk.appendChild(groupEl(c,pid)));
  n.vids.forEach(v=>gk.appendChild(vidEl(v,pid)));
  h.onclick=()=>g.classList.toggle('open');
  g.appendChild(h); g.appendChild(gk); return g;
}

function vidEl(v,pid){
  const d=el('div','vid'+(v.locked?' locked':'')); d.dataset.vid=v.videoId;
  const ic=v.locked
    ? '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    : '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  d.innerHTML=ic+'<span class="vt">'+esc(v.title||('视频'+v.videoId))+'</span><span class="dur">'+fmtDur(v.duration)+'</span>';
  if(!v.locked) d.onclick=()=>play(v,pid);
  return d;
}

async function openCourse(pid, vid){
  const wrap=document.querySelector('.course[data-pid="'+pid+'"]'); if(!wrap)return;
  const kids=wrap.querySelector('.kids');
  await toggleCourse(wrap,kids,pid);
  wrap.scrollIntoView({block:'nearest'});
  if(vid){ const v=(byId[pid]._vids||[]).find(x=>x.videoId==vid); if(v)play(v,pid); }
}

async function play(v,pid){
  curList=(byId[pid]._vids||[]).filter(x=>!x.locked);
  activeVid=v.videoId;
  document.querySelectorAll('.vid.active').forEach(e=>e.classList.remove('active'));
  const node=document.querySelector('.vid[data-vid="'+v.videoId+'"]'); if(node)node.classList.add('active');
  $('#crumb').innerHTML='<b>'+esc(byId[pid].name)+'</b>'+[v.module,v.topic,v.examKey].filter(x=>x).map(x=>' › '+esc(x)).join('');
  $('#vtitle').textContent=v.title||('视频 '+v.videoId);
  $('#vsub').textContent=[v.examKey,fmtDur(v.duration)&&('时长 '+fmtDur(v.duration))].filter(x=>x).join(' · ');
  $('#ph').style.display='none';
  updNav(); closeDrawer(); localStorage.setItem('last',JSON.stringify({pid,vid:v.videoId}));
  $('#dl').onclick=()=>{const c='python3 youdao_course.py download -r req.txt --video '+v.videoId+' -o "'+(v.title||v.videoId)+'.mp4"';navigator.clipboard&&navigator.clipboard.writeText(c);toast('下载命令已复制');};
  try{
    const m3u8=pickM3u8(v);
    if(!m3u8){ toast('该讲暂无可播放地址（可能未解锁）'); return; }
    const r=await api('/api/play?videoId='+v.videoId+'&contentId='+v.contentId
      +'&cardPackageId='+v.cardPackageId+'&productId='+v.productId
      +'&m3u8='+encodeURIComponent(m3u8));
    loadSrc(r.url);
  }catch(e){ toast('取流失败：'+e.message); }
}

function pickM3u8(v){
  const c=(v.clarity||[]).filter(x=>x&&x.url).sort((a,b)=>(b.type||0)-(a.type||0));
  return c.length?c[0].url:(v.downloadUrl||null);
}

function loadSrc(url){
  const vd=$('#v');
  if(window.Hls&&Hls.isSupported()){
    if(!hls){ hls=new Hls({maxBufferLength:30}); hls.attachMedia(vd);
      hls.on(Hls.Events.MANIFEST_PARSED,()=>vd.play().catch(()=>{}));
      hls.on(Hls.Events.ERROR,(e,d)=>{ if(d.fatal)toast('播放错误，可能未解锁或会话过期'); }); }
    hls.loadSource(url);
  }else{ vd.src=url; vd.play().catch(()=>{}); }
}

function updNav(){
  const i=curList.findIndex(x=>x.videoId===activeVid);
  $('#prev').disabled=!(i>0); $('#next').disabled=!(i>=0&&i<curList.length-1);
  $('#prev').onclick=()=>{ if(i>0)play(curList[i-1],curList[i-1].productId); };
  $('#next').onclick=()=>{ if(i<curList.length-1)play(curList[i+1],curList[i+1].productId); };
}
$('#v').addEventListener('ended',()=>{ const b=$('#next'); if(!b.disabled)b.click(); });

// search filter
$('#q').addEventListener('input',e=>{
  const q=e.target.value.trim().toLowerCase();
  document.querySelectorAll('.course').forEach(c=>{
    const name=(byId[c.dataset.pid]||{}).name||'';
    let any=!q||name.toLowerCase().includes(q);
    c.querySelectorAll('.vid').forEach(v=>{
      const t=v.querySelector('.vt').textContent.toLowerCase();
      const hit=!q||t.includes(q)||name.toLowerCase().includes(q);
      v.style.display=hit?'':'none'; if(hit)any=true;
    });
    c.style.display=any?'':'none';
    c.querySelectorAll('.grp').forEach(g=>{
      const vis=[...g.querySelectorAll('.vid')].some(v=>v.style.display!=='none');
      g.style.display=vis?'':'none';
    });
    if(q&&any)c.classList.add('open');
  });
});
$('#hamb').onclick=()=>$('#app').classList.toggle('drawer');
$('#scrim').onclick=closeDrawer;
init();
</script>
</body>
</html>
"""


HLS_JS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"
_HLS_JS_CACHE = {}


def hls_js_bytes():
    """本地代理自带 hls.js（首次从 CDN 取一次并缓存），避免浏览器直连 CDN 失败。"""
    if "data" not in _HLS_JS_CACHE:
        try:
            req = urllib.request.Request(HLS_JS_CDN, headers={"User-Agent": "youdao_course"})
            with urllib.request.urlopen(req, timeout=30) as r:
                _HLS_JS_CACHE["data"] = r.read()
        except Exception:  # noqa: BLE001
            _HLS_JS_CACHE["data"] = b""
    return _HLS_JS_CACHE["data"]


def make_handler(base_headers, default_url="", session=None, auto=None):
    session = session if session is not None else base_headers
    page = APP_HTML.replace("__AUTO__", json.dumps(auto) if auto else "null")
    video_headers = {}
    vh_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            sys.stderr.write("[proxy] " + (fmt % args) + "\n")

        def _send_bytes(self, status, body, content_type, extra=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, obj, status=200):
            self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                             "application/json; charset=utf-8")

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path in ("/", "/index.html"):
                self._send_bytes(200, page.encode("utf-8"), "text/html; charset=utf-8")
            elif path == "/hls.js":
                js = hls_js_bytes()
                self._send_bytes(200 if js else 502, js or b"// hls.js unavailable",
                                 "application/javascript; charset=utf-8")
            elif path == "/api/courses":
                self._api_courses()
            elif path == "/api/course":
                self._api_course(qs)
            elif path == "/api/play":
                self._api_play(qs)
            elif path == "/p":
                self._proxy(qs)
            else:
                self._send_bytes(404, b"not found", "text/plain")

        def _api_courses(self):
            try:
                prods = list_products(session)
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 502)
                return
            courses = [{
                "id": p.get("id"), "name": p.get("name"),
                "cardType": p.get("cardType"),
                "authors": [a.get("name") if isinstance(a, dict) else a
                            for a in (p.get("authors") or [])],
            } for p in prods]
            self._send_json({"courses": courses})

        def _api_course(self, qs):
            pid = (qs.get("productId") or [None])[0]
            if not pid:
                self._send_json({"error": "missing productId"}, 400)
                return
            try:
                self._send_json({"videos": get_product_videos(session, pid)})
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 502)

        def _api_play(self, qs):
            try:
                video = {
                    "videoId": int(qs["videoId"][0]),
                    "contentId": int(qs["contentId"][0]),
                    "cardPackageId": int(qs["cardPackageId"][0]),
                    "productId": int(qs["productId"][0]),
                }
            except (KeyError, ValueError):
                self._send_json({"error": "bad params"}, 400)
                return
            m3u8 = (qs.get("m3u8") or [None])[0] or resolve_m3u8(session, video)
            if not m3u8:
                self._send_json({"error": "no m3u8 (locked?)"}, 502)
                return
            hdrs = play_headers(session, video, m3u8)
            with vh_lock:
                video_headers[str(video["videoId"])] = hdrs
            self._send_json({"url": _proxify(m3u8, video["videoId"]), "m3u8": m3u8})

        def _proxy(self, qs):
            if "u" not in qs:
                self._send_bytes(400, b"missing u", "text/plain")
                return
            target = qs["u"][0]
            vid = (qs.get("vid") or [None])[0]
            with vh_lock:
                hdrs = video_headers.get(vid, base_headers) if vid else base_headers
            fwd = forward_headers(hdrs, self.headers.get("Range"))
            req = urllib.request.Request(target, headers=fwd, method="GET")
            try:
                resp = urllib.request.urlopen(req, timeout=60)
            except urllib.error.HTTPError as e:
                self._send_bytes(e.code, e.read() or b"",
                                 e.headers.get("Content-Type", "text/plain"))
                return
            except Exception as e:  # noqa: BLE001
                self._send_bytes(502, str(e).encode("utf-8"), "text/plain")
                return
            with resp:
                ctype = resp.headers.get("Content-Type", "")
                data = resp.read()
                status = resp.status
            if _looks_like_m3u8(target, ctype):
                rewritten = rewrite_m3u8(data.decode("utf-8", "replace"), target, vid)
                self._send_bytes(200, rewritten.encode("utf-8"),
                                 "application/vnd.apple.mpegurl")
                return
            self._send_bytes(status, data, ctype or "application/octet-stream",
                             {"Accept-Ranges": "bytes"})

    return Handler


class _QuietServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 播放器/ffmpeg 提前断开连接很正常，不刷栈
        if sys.exc_info()[0] in (ConnectionResetError, BrokenPipeError):
            return
        super().handle_error(request, client_address)


def start_proxy(headers, port, default_url="", session=None, auto=None):
    server = _QuietServer(("127.0.0.1", port),
                          make_handler(headers, default_url, session, auto))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# 课程 / 视频枚举（只要会话 Cookie 就能列出全部课程和视频，不用一个个抓）
# ---------------------------------------------------------------------------
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
    out.setdefault("User-Agent", "YoudaoCourse/iPhone")
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
        })
    for key in ("subOutlines", "outlines"):
        if node.get(key):
            _walk_outline(node[key], pkg_id, product_id, out)


def get_product_videos(session, product_id):
    """返回某课程下所有视频（含 videoId / contentId / cardPackageId / productId / m3u8）。"""
    d = (api_get_json(session, API_PRODUCT_DETAIL % product_id).get("data") or {})
    out = []
    tab = d.get("videoPackageTab") or {}
    pkgs = tab.get("videoPackages") or []
    for pkg in pkgs:
        _walk_outline(pkg.get("outlines"), pkg.get("videoPackageId"), product_id, out)
    # 直播回放：cardPackageId 复用主视频包（最佳猜测）
    live_pkg = pkgs[0].get("videoPackageId") if pkgs else None
    for live in (d.get("servicePackage") or {}).get("videoLiveTab") or []:
        _walk_outline(live.get("outlines"), live_pkg, product_id, out)
    return out


def find_video(session, video_id):
    """在所有课程里找到指定 videoId 的视频条目。"""
    video_id = int(video_id)
    for prod in list_products(session):
        for v in get_product_videos(session, prod["id"]):
            if v.get("videoId") == video_id:
                v["productName"] = prod.get("name")
                return v
    return None


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
        pass
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
    return h


def load_session(args):
    if args.request:
        with open(args.request, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        raise SystemExit("请用 --request <文件> 指定抓包原文，或从标准输入管道传入。")
    url, headers = parse_request(text)
    return url, headers


def cmd_parse(args):
    url, headers = load_session(args)
    print("URL :", url)
    print("Headers:")
    for k, v in headers.items():
        if k.lower() == "cookie" and len(v) > 60:
            v = v[:57] + "..."
        print("  %s: %s" % (k, v))


def cmd_list(args):
    _, session = load_session(args)
    prods = list_products(session)
    print("共 %d 门课：\n" % len(prods))
    for prod in prods:
        vids = []
        try:
            vids = get_product_videos(session, prod["id"])
        except Exception as e:  # noqa: BLE001
            print("== [%s] %s  (读取失败: %s)" % (prod["id"], prod.get("name"), e))
            continue
        print("== [product %s] %s  —— %d 个视频" %
              (prod["id"], prod.get("name"), len(vids)))
        for v in vids:
            lock = "🔒未解锁" if v["locked"] else "可看"
            print("   video %-7s %-4s %s / %s" %
                  (v["videoId"], lock, v.get("examKey") or "", v.get("title") or ""))
        print()
    print("播放某个：python3 youdao_course.py serve -r %s --video <videoId>"
          % (args.request or "req.txt"))


def _resolve_video(args, session):
    print("正在按 videoId=%s 查找视频……" % args.video)
    v = find_video(session, args.video)
    if not v:
        raise SystemExit("没找到 videoId=%s（确认它在你的已购课程里）。" % args.video)
    if v["locked"]:
        print("注意：该视频在 App 里显示未解锁，可能取不到地址。")
    m3u8 = resolve_m3u8(session, v)
    if not m3u8:
        raise SystemExit("拿不到该视频的 m3u8 地址（可能未解锁）。")
    print("找到：%s / %s" % (v.get("productName"), v.get("title")))
    return play_headers(session, v, m3u8), m3u8


def cmd_serve(args):
    _, session = load_session(args)
    auto = None
    if getattr(args, "video", None):
        print("正在定位 videoId=%s 以便自动播放……" % args.video)
        v = find_video(session, args.video)
        if v:
            auto = {"productId": v["productId"], "videoId": v["videoId"]}
        else:
            print("没找到该 videoId，将正常打开课程列表。")
    server = start_proxy(session, args.port, "", session, auto)
    print("课程网页已启动： http://127.0.0.1:%d" % args.port)
    print("左侧选课、选讲即可播放，支持搜索 / 倍速 / 上下一讲。Ctrl-C 退出。")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n已退出。")
        server.shutdown()


def cmd_download(args):
    default_url, headers = load_session(args)
    if getattr(args, "video", None):
        headers, default_url = _resolve_video(args, headers)
    m3u8_url = args.url or default_url
    if not _looks_like_m3u8(m3u8_url, ""):
        print("警告：地址看起来不是 .m3u8，可能下不到完整视频：", m3u8_url)

    if not _which("ffmpeg"):
        raise SystemExit("没找到 ffmpeg，请先安装：brew install ffmpeg")

    server = start_proxy(headers, args.port)
    proxied = "http://127.0.0.1:%d/p?u=%s" % (
        args.port, urllib.parse.quote(m3u8_url, safe=""))

    out = args.output
    cmd = ["ffmpeg", "-y", "-i", proxied, "-c", "copy",
           "-bsf:a", "aac_adtstoasc", out]
    print("运行：", " ".join(cmd))
    rc = subprocess.call(cmd)
    if rc != 0:
        print("直接 copy 失败，改用重新编码再试一次……")
        rc = subprocess.call(["ffmpeg", "-y", "-i", proxied, out])
    server.shutdown()
    if rc == 0:
        print("完成：", os.path.abspath(out))
    else:
        raise SystemExit("ffmpeg 失败，请检查会话是否过期（重新抓包）或地址是否正确。")


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def build_parser():
    p = argparse.ArgumentParser(
        description="把有道听课客户端抓到的加密 HLS 流，变成浏览器/任意播放器能看的视频。")
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--request", "-r",
                        help="抓包复制出来的请求原文文件（含 .m3u8 那条）。不传则从 stdin 读。")
    common.add_argument("--port", type=int, default=8808, help="本地代理端口（默认 8808）。")

    lp = sub.add_parser("list", parents=[common],
                        help="列出所有已购课程和视频（只需会话 Cookie）。")
    lp.set_defaults(func=cmd_list)

    sp = sub.add_parser("serve", parents=[common], help="起本地代理 + 网页播放器，浏览器在线看。")
    sp.add_argument("--video", "-V", help="要播放的 videoId（用 list 查到）；不传则放 req.txt 里那条。")
    sp.set_defaults(func=cmd_serve)

    dp = sub.add_parser("download", parents=[common], help="下载并合并成 mp4（需要 ffmpeg）。")
    dp.add_argument("--video", "-V", help="要下载的 videoId（用 list 查到）。")
    dp.add_argument("--url", "-u", help="要下载的 m3u8 地址；不传则用 --video 或原文里那条。")
    dp.add_argument("--output", "-o", default="output.mp4", help="输出文件名（默认 output.mp4）。")
    dp.set_defaults(func=cmd_download)

    pp = sub.add_parser("parse", parents=[common], help="只解析并打印抓到的地址和头（排错用）。")
    pp.set_defaults(func=cmd_parse)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
