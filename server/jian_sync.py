#!/usr/bin/python3
"""笺 · 同步服务器（只用 Python 标准库）

  · 提供手机网页版（静态文件，由 build_web.py 生成）
  · POST /api/sync   合并一份设备上的数据并返回合并结果（规则见 syncmerge.py）
  · POST /api/login  用同步密码换一个设备令牌
  · GET  /api/ping   连通性检查
  · 手机提醒（Web Push，需要 python3-cryptography，没有也不影响同步）：
      GET  /api/push/key   服务器的推送公钥
      POST /api/push       手机登记推送订阅和它的提醒设置（提前几分钟、时区）
      POST /api/push/off   取消订阅；POST /api/push/test 发一条测试通知
    到点由后台线程发推送，规则和桌面端提醒一样（见 jian.py 的 Reminder）

用法：
  jian_sync.py serve  --state DIR --web DIR [--port 8443] [--cert F --key F | --plain]
  jian_sync.py passwd --state DIR [--random]      设置同步密码（从标准输入读，或随机生成并打印）
  jian_sync.py token  --state DIR 名称             新建一个设备令牌并打印（给桌面端用）
  jian_sync.py tokens --state DIR                  列出设备
  jian_sync.py revoke --state DIR 名称             注销某台设备
状态目录里：doc.json（同步数据）、auth.json（密码哈希与令牌哈希）、backups/（每天一份，保留 30 天）、
push.json（推送订阅）、vapid.pem（推送签名密钥）。
"""
import argparse
import collections
import datetime
import hashlib
import hmac
import http.server
import json
import os
import secrets
import shutil
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from zoneinfo import ZoneInfo

_here = os.path.dirname(os.path.realpath(__file__))
sys.path[:0] = [_here, os.path.dirname(_here)]   # 部署时 syncmerge.py 放在同目录；在仓库里则在上一级
import syncmerge  # noqa: E402

MAX_BODY = 4 << 20
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
         '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def write_json(path, obj, mode=0o600):
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            v = json.load(f)
            return v if isinstance(v, type(default)) else default
    except FileNotFoundError:
        return default


# ───────────────────────── 同步数据 ─────────────────────────
class Store:
    def __init__(self, state):
        self.path = os.path.join(state, 'doc.json')
        self.backups = os.path.join(state, 'backups')
        os.makedirs(self.backups, exist_ok=True)
        self.lock = threading.Lock()
        self.doc = syncmerge.part(read_json(self.path, {}))

    def sync(self, incoming):
        with self.lock:
            merged = syncmerge.merge(self.doc, syncmerge.part(incoming))
            if not syncmerge.same(merged, self.doc):
                self._backup()
                write_json(self.path, merged)
                self.doc = merged
            return self.doc

    def _backup(self):   # 每天第一次改动前留一份，保留 30 天
        day = datetime.date.today().isoformat()
        dst = os.path.join(self.backups, f'doc-{day}.json')
        if os.path.exists(self.path) and not os.path.exists(dst):
            shutil.copy2(self.path, dst)
            for f in sorted(x for x in os.listdir(self.backups) if x.startswith('doc-'))[:-30]:
                os.remove(os.path.join(self.backups, f))


# ───────────────────────── 密码与设备令牌 ─────────────────────────
def pw_hash(pw, salt):
    return hashlib.scrypt(pw.encode(), salt=salt, n=1 << 14, r=8, p=1, dklen=32)


class Auth:
    """auth.json 可能被命令行（passwd / token / revoke）在服务运行时改掉，所以每次用之前看一眼文件有没有变。"""
    def __init__(self, state):
        self.path = os.path.join(state, 'auth.json')
        self.lock = threading.Lock()
        self.flock = threading.Lock()
        self.mtime = None
        self.a = {}
        self.fails = collections.defaultdict(collections.deque)   # ip -> 失败时间

    def _fresh(self):   # 调用方持有 self.lock
        try:
            m = os.stat(self.path).st_mtime_ns
        except FileNotFoundError:
            m = 0
        if m != self.mtime:
            self.a = read_json(self.path, {})
            self.a.setdefault('tokens', [])
            self.mtime = m

    def _save(self):
        write_json(self.path, self.a)
        self.mtime = os.stat(self.path).st_mtime_ns

    def has_password(self):
        with self.lock:
            self._fresh()
            return bool(self.a.get('pw'))

    def set_password(self, pw):
        salt = secrets.token_bytes(16)
        with self.lock:
            self._fresh()
            self.a['pw'] = {'salt': salt.hex(), 'hash': pw_hash(pw, salt).hex()}
            self._save()

    def check_password(self, pw):   # 在锁里算 scrypt：同一时间只验一个，顺便限制了猜密码的速度
        with self.lock:
            self._fresh()
            p = self.a.get('pw')
            return bool(p) and hmac.compare_digest(pw_hash(pw, bytes.fromhex(p['salt'])).hex(), p['hash'])

    def allowed(self, ip):   # 同一个地址 15 分钟内最多错 6 次，全部加起来最多 30 次
        now = time.time()
        total = 0
        with self.flock:
            for k in list(self.fails):
                q = self.fails[k]
                while q and now - q[0] > 900:
                    q.popleft()
                if not q:
                    del self.fails[k]
                else:
                    total += len(q)
            return len(self.fails.get(ip, ())) < 6 and total < 30

    def failed(self, ip):
        with self.flock:
            self.fails[ip].append(time.time())

    def new_token(self, name):
        tok = secrets.token_urlsafe(32)
        with self.lock:
            self._fresh()
            self.a['tokens'].append({'h': hashlib.sha256(tok.encode()).hexdigest(), 'name': name[:40],
                                     'created': int(time.time()), 'seen': 0})
            self._save()
        return tok

    def check_token(self, tok):
        if not tok:
            return None
        h = hashlib.sha256(tok.encode()).hexdigest()
        with self.lock:
            self._fresh()
            for t in self.a['tokens']:
                if hmac.compare_digest(t['h'], h):
                    now = int(time.time())
                    if now - t.get('seen', 0) > 3600:   # 最近一次使用时间，按小时记就够了
                        t['seen'] = now
                        self._save()
                    return t
        return None

    def tokens(self):
        with self.lock:
            self._fresh()
            return list(self.a['tokens'])

    def revoke(self, name):
        with self.lock:
            self._fresh()
            n = len(self.a['tokens'])
            self.a['tokens'] = [t for t in self.a['tokens'] if t['name'] != name]
            self._save()
            return n - len(self.a['tokens'])


# ───────────────────────── 手机提醒（Web Push） ─────────────────────────
def hm(m):
    return f'{m // 60:02d}:{m % 60:02d}'


class Push:
    """各手机的推送订阅（连同它在设置里选的提前几分钟、用的时区）存在 push.json。
    后台线程每 20 秒看一眼接下来的日程，到点给订阅了的手机发推送。设备被注销后，它的订阅一并作废。"""
    MAX_SUBS = 20

    def __init__(self, state, store, auth):
        self.path = os.path.join(state, 'push.json')
        self.store, self.auth = store, auth
        self.lock = threading.Lock()
        p = read_json(self.path, {})
        self.subs = [s for s in p.get('subs', []) if isinstance(s, dict) and isinstance(s.get('endpoint'), str)]
        self.sent = {k: v for k, v in (p.get('sent') or {}).items() if isinstance(v, (int, float))}
        try:
            import webpush
            self.wp = webpush
            self.vapid = webpush.Vapid(os.path.join(state, 'vapid.pem'))
        except ImportError:
            self.wp = self.vapid = None
            log('没有 python3-cryptography：手机提醒不可用（同步不受影响）')

    def _save(self):   # 调用方持有 self.lock
        write_json(self.path, {'subs': self.subs, 'sent': self.sent})

    def key(self):
        return self.vapid.pub if self.vapid else None

    def upsert(self, tok, body):
        """手机登记（或更新）订阅和提醒设置；同一个推送地址只留一份。出错时返回说明。"""
        sub = body.get('sub') if isinstance(body, dict) else None
        if not isinstance(sub, dict):
            return '缺少订阅信息'
        ep, keys = sub.get('endpoint'), sub.get('keys') if isinstance(sub.get('keys'), dict) else {}
        if not isinstance(ep, str) or len(ep) > 1000 or not self.wp.allowed(ep):
            return '不认识的推送服务'
        try:
            if len(self.wp.unb64u(keys['p256dh'])) != 65 or len(self.wp.unb64u(keys['auth'])) < 16:
                raise ValueError
        except Exception:
            return '订阅格式不对'
        remind = body.get('remind')
        remind = int(remind) if isinstance(remind, (int, float)) and 0 <= remind <= 120 else 10
        tz = body.get('tz') if isinstance(body.get('tz'), str) else 'UTC'
        try:
            ZoneInfo(tz)
        except Exception:
            tz = 'UTC'
        rec = {'endpoint': ep, 'p256dh': keys['p256dh'], 'auth': keys['auth'], 'remind': remind, 'tz': tz,
               'tok': tok, 'at': int(time.time())}
        with self.lock:
            self.subs = ([s for s in self.subs if s['endpoint'] != ep] + [rec])[-self.MAX_SUBS:]
            self._save()
        return None

    def remove(self, endpoints):
        with self.lock:
            n = len(self.subs)
            self.subs = [s for s in self.subs if s['endpoint'] not in endpoints]
            if len(self.subs) != n:
                self._save()

    def find(self, ep, tok):
        with self.lock:
            return next((s for s in self.subs if s['endpoint'] == ep and s.get('tok') == tok), None)

    def send(self, sub, payload, ttl=600, topic=None):
        status, info = self.wp.send(self.vapid, sub, payload, ttl=ttl, topic=topic)
        if not 200 <= status < 300:
            log(f'推送失败 {urllib.parse.urlsplit(sub["endpoint"]).hostname} {status} {info[:160]}')
        if status in (404, 410):   # 手机上取消了订阅、删了 App，或订阅过期
            self.remove({sub['endpoint']})
        return status, info

    def due(self, doc, sub, now):
        """这个订阅现在该提醒哪些日程：[(去重键, 开始时刻, 通知内容)]。和桌面端 Reminder 同一套规则。"""
        tz, lead = ZoneInfo(sub['tz']), sub['remind']
        today = datetime.datetime.fromtimestamp(now, tz).date()
        tag = hashlib.sha256(sub['endpoint'].encode()).hexdigest()[:10]
        out = []
        for d in (today, today + datetime.timedelta(days=1)):
            for ev in doc['events']:
                if ev.get('remind') is False or not syncmerge.occurs_on(ev, d):
                    continue
                try:
                    s, e = int(ev.get('start', 0)), int(ev.get('end', 0))
                except (TypeError, ValueError):
                    continue
                wall = datetime.datetime.combine(d, datetime.time()) + datetime.timedelta(minutes=s)
                start = wall.replace(tzinfo=tz).timestamp()
                key = f'{tag}|{ev["id"]}@{d}@{s}'
                if not (start - lead * 60 <= now < start) or key in self.sent:
                    continue
                left = max(1, round((start - now) / 60))
                todo = [t for t in doc['tasks'] if t.get('eventId') == ev['id'] and t.get('date') == d.isoformat()
                        and not t.get('done')]
                body = f'{left} 分钟后开始 · {hm(s)}–{hm(e)}'
                if todo:
                    body += '\n' + '\n'.join('☐ ' + str(t.get('text', ''))[:60] for t in todo[:4])
                    if len(todo) > 4:
                        body += f'\n…… 还有 {len(todo) - 4} 项'
                out.append((key, start, {'title': str(ev.get('title') or '未命名日程')[:80], 'body': body,
                                         'date': d.isoformat(), 'id': ev['id'], 'tag': f'{ev["id"]}@{d}'}))
        return out

    def tick(self, now=None):
        if not self.vapid:
            return
        now = time.time() if now is None else now
        doc = self.store.doc
        valid = {t['h'][:16] for t in self.auth.tokens()}
        with self.lock:
            subs = list(self.subs)
        gone = {s['endpoint'] for s in subs if s.get('tok') not in valid}   # 设备已注销
        dirty = False
        for sub in subs:
            if sub['endpoint'] in gone or sub.get('remind', 0) <= 0:
                continue
            for key, start, payload in self.due(doc, sub, now):
                topic = hashlib.sha256(payload['tag'].encode()).hexdigest()[:32]
                status, _ = self.send(sub, payload, ttl=max(60, start - now), topic=topic)
                if status in (404, 410):
                    break
                if status and status < 500 and status != 429:   # 网络不通、对方忙：下一轮（20 秒后）再试
                    with self.lock:
                        self.sent[key] = now
                    dirty = True
        with self.lock:
            cut = now - 2 * 86400
            old = len(self.sent)
            self.sent = {k: v for k, v in self.sent.items() if v >= cut}
            n = len(self.subs)
            self.subs = [s for s in self.subs if s['endpoint'] not in gone]
            if len(self.subs) != n:
                log(f'清掉了 {n - len(self.subs)} 个已注销设备的推送订阅')
            if dirty or len(self.sent) != old or len(self.subs) != n:
                self._save()

    def run(self):
        while True:
            time.sleep(20 - time.time() % 20 + 0.5)
            try:
                self.tick()
            except Exception as e:
                log('提醒检查出错', repr(e)[:200])


# ───────────────────────── HTTP ─────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'jian'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 30

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body=b'', ctype='application/json', headers=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', CSP)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        log(f'{self.client_address[0]} {self.command} {urllib.parse.urlsplit(self.path).path} {code}')

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode(),
                   headers=[('Cache-Control', 'no-store')])

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError('body')
        return json.loads(self.rfile.read(n))

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/api/ping':
            return self._json(200, {'ok': True})
        if path == '/api/push/key':
            key = self.server.push.key()
            return self._json(200, {'key': key}) if key else self._json(503, {'error': '服务器还不支持手机提醒'})
        if path.startswith('/api/'):
            return self._json(404, {'error': '没有这个接口'})
        self._static(path)

    do_HEAD = do_GET

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            body = self._body()
        except Exception:
            return self._json(400, {'error': '请求格式不对'})
        if path == '/api/login':
            return self._login(body)
        if path not in ('/api/sync', '/api/push', '/api/push/off', '/api/push/test'):
            return self._json(404, {'error': '没有这个接口'})
        t = self.server.auth.check_token((self.headers.get('Authorization') or '').removeprefix('Bearer ').strip())
        if not t:
            return self._json(401, {'error': '未登录'})
        if path == '/api/sync':
            return self._json(200, self.server.store.sync(body))
        push, tok = self.server.push, t['h'][:16]
        if not push.vapid:
            return self._json(503, {'error': '服务器还不支持手机提醒'})
        ep = body.get('endpoint') if isinstance(body, dict) else None
        if path == '/api/push':
            err = push.upsert(tok, body)
            return self._json(400, {'error': err}) if err else self._json(200, {'ok': True})
        if path == '/api/push/off':
            if isinstance(ep, str):
                push.remove({ep})
            return self._json(200, {'ok': True})
        sub = push.find(ep, tok) if isinstance(ep, str) else None   # /api/push/test
        if not sub:
            return self._json(404, {'error': '服务器上没有这台手机的订阅'})
        status, _ = push.send(sub, {'title': '笺 · 提醒已开启', 'tag': 'jian-test', 'body':
                                    f'日程开始前 {sub["remind"]} 分钟，会像这样提醒你。' if sub['remind'] else '提前提醒现在是关着的。'})
        return self._json(200, {'ok': 200 <= status < 300, 'status': status})

    def _login(self, body):
        ip, auth = self.client_address[0], self.server.auth
        if not auth.allowed(ip):
            return self._json(429, {'error': '试错太多次了，过一刻钟再试'})
        pw = body.get('password') if isinstance(body, dict) else None
        if not isinstance(pw, str) or not auth.check_password(pw):
            auth.failed(ip)
            time.sleep(0.6)
            return self._json(403, {'error': '密码不对'})
        name = body.get('device') if isinstance(body.get('device'), str) else '设备'
        return self._json(200, {'token': auth.new_token(name)})

    def _static(self, path):
        root = self.server.web
        rel = urllib.parse.unquote(path).lstrip('/') or 'index.html'
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return self._send(404, b'not found', 'text/plain; charset=utf-8')
        st = os.stat(full)
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
        name = os.path.basename(full)
        # 字体、图标几乎不变，缓存一周；界面文件每次都回服务器确认（没变只回 304）
        cache = 'public, max-age=604800' if rel.startswith('fonts/') or name.endswith('.png') else 'no-cache'
        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', cache)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        with open(full, 'rb') as f:
            body = f.read()
        ctype = TYPES.get(os.path.splitext(name)[1].lower(), 'application/octet-stream')
        self._send(200, body, ctype, [('ETag', etag), ('Cache-Control', cache)])


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def handle_error(self, request, client_address):   # 握手失败、半路断开之类，记一行就好
        log(f'{client_address[0]} error: {sys.exc_info()[1]!r}'[:200])


def serve(args):
    state = os.path.realpath(args.state)
    srv = Server((args.host, args.port), Handler, bind_and_activate=False)
    srv.socket = socket.socket(socket.AF_INET6 if ':' in args.host else socket.AF_INET, socket.SOCK_STREAM)
    srv.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.server_bind()
    srv.server_activate()
    if not args.plain:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(args.cert, args.key)
        # 握手放到各自的处理线程里做（读第一个字节时），慢的连接不会卡住 accept
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    srv.store = Store(state)
    srv.auth = Auth(state)
    srv.web = os.path.realpath(args.web)
    srv.push = Push(state, srv.store, srv.auth)
    if srv.push.vapid:
        threading.Thread(target=srv.push.run, daemon=True).start()
    if not srv.auth.has_password():
        log('还没有设置同步密码：jian_sync.py passwd --state', state)
    log(f'jian-sync listening on {args.host}:{args.port} ({"http" if args.plain else "https"})')
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description='笺 · 同步服务器')
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('serve')
    s.add_argument('--state', required=True)
    s.add_argument('--web', required=True)
    s.add_argument('--host', default='0.0.0.0')
    s.add_argument('--port', type=int, default=8443)
    s.add_argument('--cert')
    s.add_argument('--key')
    s.add_argument('--plain', action='store_true', help='不加密（只用于本机测试）')
    p = sub.add_parser('passwd')
    p.add_argument('--state', required=True)
    p.add_argument('--random', action='store_true')
    t = sub.add_parser('token')
    t.add_argument('--state', required=True)
    t.add_argument('name')
    ls = sub.add_parser('tokens')
    ls.add_argument('--state', required=True)
    r = sub.add_parser('revoke')
    r.add_argument('--state', required=True)
    r.add_argument('name')
    args = ap.parse_args()
    if args.cmd == 'serve':
        if not args.plain and not (args.cert and args.key):
            ap.error('需要 --cert 和 --key（或本机测试时用 --plain）')
        return serve(args)
    os.makedirs(args.state, exist_ok=True)
    auth = Auth(args.state)
    if args.cmd == 'passwd':
        if args.random:   # 好认好输：去掉容易混淆的字符，4 组 4 位
            abc = 'abcdefghjkmnpqrstuvwxyz23456789'
            pw = '-'.join(''.join(secrets.choice(abc) for _ in range(4)) for _ in range(4))
            print(pw)
        else:
            pw = sys.stdin.readline().strip()
            if len(pw) < 8:
                sys.exit('密码至少 8 位')
        auth.set_password(pw)
    elif args.cmd == 'token':
        print(auth.new_token(args.name))
    elif args.cmd == 'tokens':
        for x in auth.tokens():
            seen = datetime.datetime.fromtimestamp(x['seen']).strftime('%Y-%m-%d %H:%M') if x.get('seen') else '-'
            print(f"{x['name']}\t创建 {datetime.datetime.fromtimestamp(x['created']):%Y-%m-%d}\t最近 {seen}")
    elif args.cmd == 'revoke':
        print('注销了', auth.revoke(args.name), '个')


if __name__ == '__main__':
    main()
