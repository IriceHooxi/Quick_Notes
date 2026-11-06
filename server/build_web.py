#!/usr/bin/python3
"""把 ui/ 打包成手机网页版（PWA），交给同步服务器托管。

  server/build_web.py [--out dist/web]

在 ui/ 的基础上：
  · index.html 加上「添加到主屏幕」需要的 meta、图标和 manifest，并在 app.js 之前载入 web-boot.js
  · web-boot.js   告诉 app.js「这是手机网页版」（window.__WEB__）
  · sw.js         Service Worker：界面文件整版缓存，断网也能打开；字体用到哪个存哪个
  · manifest.webmanifest 和 icon-180/192/512.png（不透明底，iOS 会自己切圆角）
构建号取自界面文件内容的哈希：内容不变，构建号就不变，手机上也不会重复更新。
"""
import argparse
import hashlib
import json
import os
import re
import shutil

import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
UI = os.path.join(ROOT, 'ui')
BG = '#efe6d2'          # 图标底色和启动底色（和默认「宣纸」主题的纸色相近）
ICON_BG = 0xe6d8bcff    # 图标底色略深一点，好衬出纸张


def version():
    with open(os.path.join(ROOT, 'jian.py'), encoding='utf-8') as f:
        m = re.search(r"^VERSION = '(.*)'$", f.read(), re.M)
    return m.group(1) if m else 'dev'


def build_id():
    h = hashlib.sha256()
    for d, dirs, files in sorted(os.walk(UI)):
        dirs.sort()
        for n in sorted(files):
            p = os.path.join(d, n)
            h.update(os.path.relpath(p, UI).encode() + b'\0')
            with open(p, 'rb') as f:
                h.update(f.read())
    h.update(open(os.path.realpath(__file__), 'rb').read())   # 构建脚本本身改了也算新版本
    return h.hexdigest()[:10]


def icon(out, size):
    pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, size, size)
    pb.fill(ICON_BG)
    inner = round(size * 0.92)
    off = (size - inner) // 2
    art = GdkPixbuf.Pixbuf.new_from_file_at_size(os.path.join(ROOT, 'assets', 'jian.svg'), inner, inner)
    art.composite(pb, off, off, inner, inner, off, off, 1, 1, GdkPixbuf.InterpType.HYPER, 255)
    pb.savev(os.path.join(out, f'icon-{size}.png'), 'png', [], [])


def write(out, name, text):
    with open(os.path.join(out, name), 'w', encoding='utf-8') as f:
        f.write(text)


SW = """// 笺 · Service Worker（由 server/build_web.py 生成）
const CORE = 'jian-core-%(build)s', FONTS = 'jian-fonts';
const FILES = %(files)s;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE)
    .then(c => c.addAll(FILES.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('jian-core-') && k !== CORE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;   // 同步接口只走网络
  if (r.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { cacheName: CORE }).then(m => m || fetch(r)));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => {
    if (res.ok && u.pathname.startsWith('/fonts/')) { const cp = res.clone(); caches.open(FONTS).then(c => c.put(r, cp)); }
    return res;
  })));
});

// 日程提醒：服务器到点推过来（内容已加密，浏览器解开后交到这里）
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || '笺', {
    body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png',
    data: { date: d.date || null, id: d.id || null },
  }));
});

// 点通知：App 开着就切过去并定位到那个日程，没开就打开它
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { date, id } = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs[0];
    if (c) { if (date) c.postMessage({ type: 'focus', date, id }); return c.focus(); }
    return self.clients.openWindow(date ? `./#focus=${date}${id ? ',' + id : ''}` : './');
  }));
});
"""


def main():
    ap = argparse.ArgumentParser(description='构建笺的手机网页版')
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist', 'web'))
    out = os.path.realpath(ap.parse_args().out)
    ver, build = version(), build_id()
    os.makedirs(out, exist_ok=True)
    shutil.copytree(UI, out, dirs_exist_ok=True)

    q = f'?v={build}'
    with open(os.path.join(UI, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    head = '\n'.join([
        f'<meta name="theme-color" content="{BG}">',
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        '<meta name="mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-title" content="笺">',
        '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
        '<meta name="format-detection" content="telephone=no">',
        '<link rel="manifest" href="manifest.webmanifest">',
        '<link rel="apple-touch-icon" href="icon-180.png">',
        '<link rel="icon" type="image/png" href="icon-192.png">',
    ])
    reps = [
        ('<meta name="viewport" content="width=device-width, initial-scale=1">',
         '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'),
        ('<title>笺</title>', '<title>笺</title>\n' + head),
        ('href="style.css"', f'href="style.css{q}"'),
        ('<script src="app.js"></script>', f'<script src="web-boot.js{q}"></script>\n<script src="app.js{q}"></script>'),
    ]
    for a, b in reps:
        if html.count(a) != 1:
            raise SystemExit(f'index.html 里找不到（或不止一处）：{a}')
        html = html.replace(a, b)
    write(out, 'index.html', html)

    write(out, 'web-boot.js', '// 由 server/build_web.py 生成：告诉 app.js 这是手机网页版\n'
          f'window.__WEB__ = {json.dumps({"build": build})};\n'
          f'window.__BOOT__ = {json.dumps({"version": ver})};\n')
    write(out, 'manifest.webmanifest', json.dumps({
        'name': '笺', 'short_name': '笺', 'description': '一周日程 + 小任务',
        'lang': 'zh-CN', 'start_url': './', 'scope': './', 'display': 'standalone',
        'background_color': BG, 'theme_color': BG,
        'icons': [{'src': f'icon-{s}.png', 'sizes': f'{s}x{s}', 'type': 'image/png'} for s in (192, 512)],
    }, ensure_ascii=False, indent=1))
    for s in (180, 192, 512):
        icon(out, s)
    files = ['./', 'index.html', f'style.css{q}', f'web-boot.js{q}', f'app.js{q}', 'fonts/wenkai/wenkai.css',
             'manifest.webmanifest', 'icon-180.png', 'icon-192.png']
    write(out, 'sw.js', SW % {'build': build, 'files': json.dumps(files)})
    print(f'笺 v{ver} 手机网页版 · 构建 {build} → {out}')


if __name__ == '__main__':
    main()
