"""笺的同步合并规则：桌面端（jian.py）和同步服务器（server/jian_sync.py）共用。
ui/app.js 里的 mergeDocs() 是同一套规则的 JS 版本，改这里时两边一起改。

参与同步的只有这几样（设置、窗口状态等留在各自设备上）：
  events / tasks   每条带 id 和 mt（最后修改时间，毫秒；老数据没有 mt 当作 0）
  gone             删除记录：id → 删除时间（毫秒）
  memo / memoMt    随记全文和它的修改时间

合并规则：
  · 同一个 id 取 mt 较大的那份（两边都改过时，后改的为准）
  · 删除时间不早于某条的 mt 就算删掉了；删除之后又改过（或撤销回来）的会留下
  · 随记取 memoMt 较大的那份（一样大时取内容较大的，保证各端一致）
  · 删除记录保留 120 天
这套规则与顺序无关、重复合并不变，所以各端不管按什么顺序、同步几次，最后都一致。
"""
import json
import time

KEEP_GONE_MS = 120 * 86400 * 1000


def _mt(x):
    v = x.get('mt')
    return v if isinstance(v, (int, float)) and v > 0 else 0


def _items(v):
    return [x for x in v if isinstance(x, dict) and isinstance(x.get('id'), str) and x['id']] if isinstance(v, list) else []


def part(d):
    """从完整数据里取出参与同步的部分（并做基本清洗）。"""
    d = d if isinstance(d, dict) else {}
    gone = d.get('gone') if isinstance(d.get('gone'), dict) else {}
    memo_mt = d.get('memoMt')
    return {
        'events': _items(d.get('events')),
        'tasks': _items(d.get('tasks')),
        'gone': {k: v for k, v in gone.items() if isinstance(k, str) and isinstance(v, (int, float)) and v > 0},
        'memo': d.get('memo') if isinstance(d.get('memo'), str) else '',
        'memoMt': memo_mt if isinstance(memo_mt, (int, float)) and memo_mt > 0 else 0,
    }


def merge(a, b, now_ms=None):
    """合并两份（已经过 part() 的）同步数据，返回新的一份；a、b 都不会被修改。"""
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    gone = dict(a['gone'])
    for k, v in b['gone'].items():
        if v > gone.get(k, 0):
            gone[k] = v
    out = {}
    for kind in ('events', 'tasks'):
        m = {x['id']: x for x in a[kind]}
        for y in b[kind]:
            x = m.get(y['id'])
            if x is None or _mt(y) > _mt(x):
                m[y['id']] = y
        out[kind] = [x for x in m.values() if gone.get(x['id'], -1) < _mt(x)]
    cut = now_ms - KEEP_GONE_MS
    out['gone'] = {k: v for k, v in gone.items() if v >= cut}
    # 时间一样（比如两边都还没改过）时比内容；按 UTF-16 比，和 JS 的字符串比较结果一致
    if b['memoMt'] > a['memoMt'] or (b['memoMt'] == a['memoMt'] and
                                     b['memo'].encode('utf-16-be') > a['memo'].encode('utf-16-be')):
        out['memo'], out['memoMt'] = b['memo'], b['memoMt']
    else:
        out['memo'], out['memoMt'] = a['memo'], a['memoMt']
    return out


def canon(p):
    """规范化后的字符串：用来判断两份同步数据是否相同（与列表顺序、键顺序无关）。"""
    return json.dumps({
        'events': sorted(p['events'], key=lambda x: x['id']),
        'tasks': sorted(p['tasks'], key=lambda x: x['id']),
        'gone': p['gone'], 'memo': p['memo'], 'memoMt': p['memoMt'],
    }, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def same(a, b):
    return canon(a) == canon(b)
