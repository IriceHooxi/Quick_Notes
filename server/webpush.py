"""Web Push：给手机（添加到主屏幕的网页 App，iOS 16.4+）发推送通知。

  · RFC 8292 VAPID：服务器用自己的密钥签一个 JWT，推送服务（苹果 / 谷歌 / Mozilla）据此认出是谁发的
  · RFC 8291 aes128gcm：通知内容用手机给的公钥加密，推送服务看不到内容
加密用 cryptography 库（Debian：python3-cryptography），不自己实现密码学。
"""
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# 只给这些推送服务发请求（订阅地址来自手机，限定一下，免得服务器被拿去访问任意网址）
PUSH_HOSTS = ('push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com')
CONTACT = 'https://github.com/IriceHooxi/Quick_Notes'   # VAPID 的 sub：推送服务有问题时找谁


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def allowed(endpoint):
    try:
        u = urllib.parse.urlsplit(endpoint)
    except ValueError:
        return False
    h = (u.hostname or '').lower()
    return u.scheme == 'https' and any(h == x or h.endswith('.' + x) for x in PUSH_HOSTS)


def raw_pub(key):
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


class Vapid:
    """服务器的推送签名密钥（P-256），第一次用时生成，存成 PEM（只有自己能读）。"""
    def __init__(self, path):
        try:
            with open(path, 'rb') as f:
                self.key = serialization.load_pem_private_key(f.read(), password=None)
        except FileNotFoundError:
            self.key = ec.generate_private_key(ec.SECP256R1())
            pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption())
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(pem)
        self.pub = b64u(raw_pub(self.key))   # 手机订阅时要用的 applicationServerKey
        self._jwt = {}

    def header(self, endpoint):
        u = urllib.parse.urlsplit(endpoint)
        aud = f'{u.scheme}://{u.netloc}'
        now = int(time.time())
        exp, tok = self._jwt.get(aud, (0, ''))
        if exp - now < 3600:   # 有效期 12 小时（苹果要求不超过 1 天），快到期前换一个
            exp = now + 12 * 3600
            seg = lambda o: b64u(json.dumps(o, separators=(',', ':')).encode())
            signing = seg({'typ': 'JWT', 'alg': 'ES256'}) + '.' + seg({'aud': aud, 'exp': exp, 'sub': CONTACT})
            r, s = decode_dss_signature(self.key.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
            tok = signing + '.' + b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
            self._jwt[aud] = (exp, tok)
        return f'vapid t={tok}, k={self.pub}'


def _hkdf(salt, info, ikm, n):
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


def encrypt(p256dh, auth, plaintext, _as_key=None, _salt=None):
    """RFC 8291 + RFC 8188（aes128gcm，单个记录）。_as_key / _salt 只给测试用。"""
    ua_pub = unb64u(p256dh)
    secret = unb64u(auth)
    as_key = _as_key or ec.generate_private_key(ec.SECP256R1())
    as_pub = raw_pub(as_key)
    shared = as_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(secret, b'WebPush: info\x00' + ua_pub + as_pub, shared, 32)
    salt = _salt or os.urandom(16)
    cek = _hkdf(salt, b'Content-Encoding: aes128gcm\x00', ikm, 16)
    nonce = _hkdf(salt, b'Content-Encoding: nonce\x00', ikm, 12)
    body = AESGCM(cek).encrypt(nonce, plaintext + b'\x02', None)   # \x02：最后一个记录的分隔符
    return salt + (4096).to_bytes(4, 'big') + bytes([len(as_pub)]) + as_pub + body


def send(vapid, sub, payload, ttl=600, urgency='high', topic=None):
    """发一条推送。返回 (HTTP 状态码, 说明)；状态码 0 表示网络不通。404/410 表示这个订阅已经失效。"""
    if not allowed(sub['endpoint']):
        return 400, '不认识的推送服务'
    body = encrypt(sub['p256dh'], sub['auth'], json.dumps(payload, ensure_ascii=False).encode())
    headers = {'Authorization': vapid.header(sub['endpoint']), 'Content-Encoding': 'aes128gcm',
               'Content-Type': 'application/octet-stream', 'TTL': str(int(ttl)), 'Urgency': urgency}
    if topic:   # 同一个 topic 的推送还没送到时，新的会替换旧的
        headers['Topic'] = topic
    req = urllib.request.Request(sub['endpoint'], data=body, method='POST', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, ''
    except urllib.error.HTTPError as e:
        try:
            msg = e.read(300).decode(errors='replace')
        except Exception:
            msg = ''
        return e.code, msg
    except Exception as e:
        return 0, repr(e)[:200]
