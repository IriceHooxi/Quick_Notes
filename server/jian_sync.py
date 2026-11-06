#!/usr/bin/python3
"""笺 · 同步服务器（只用 Python 标准库）

  · 提供手机网页版（静态文件，由 build_web.py 生成）
  · POST /api/sync   合并一份设备上的数据并返回合并结果（规则见 syncmerge.py）
  · POST /api/login  用同步密码换一个设备令牌
  · GET  /api/ping   连通性检查

用法：
  jian_sync.py serve  --state DIR --web DIR [--port 8443] [--cert F --key F | --plain]
  jian_sync.py passwd --state DIR [--random]      设置同步密码（从标准输入读，或随机生成并打印）
  jian_sync.py token  --state DIR 名称             新建一个设备令牌并打印（给桌面端用）
  jian_sync.py tokens --state DIR                  列出设备
  jian_sync.py revoke --state DIR 名称             注销某台设备
状态目录里：doc.json（同步数据）、auth.json（密码哈希与令牌哈希）、backups/（每天一份，保留 30 天）。
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
        if path == '/api/sync':
            tok = (self.headers.get('Authorization') or '').removeprefix('Bearer ').strip()
            if not self.server.auth.check_token(tok):
                return self._json(401, {'error': '未登录'})
            return self._json(200, self.server.store.sync(body))
        self._json(404, {'error': '没有这个接口'})

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
