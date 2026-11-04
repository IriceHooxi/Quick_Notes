#!/usr/bin/python3
"""笺 —— 周日程 + 便签 TODO（原生外壳）

界面在 ui/ 下（HTML/CSS/JS），本文件负责：
  · 无边框纸面窗口（拖动 / 缩放 / 置顶 / 迷你卡片）
  · 关闭即隐藏到后台 + 顶栏托盘图标（StatusNotifierItem）
  · 日程开始前的桌面通知
  · 数据读写（~/.local/share/jian/data.json，每天自动备份）
  · 单实例：再次启动只会唤出已在运行的窗口

用法：
  jian.py            打开（已在运行则唤出）
  jian.py --hidden   在后台启动（开机自启用）
  jian.py --toggle   显示 / 隐藏
  jian.py --mini     切换迷你置顶卡片
  jian.py --quit     退出正在运行的实例
  jian.py --debug    打开网页检查器与控制台输出
  jian.py --version  显示版本号
"""
import os
import sys
import json
import time
import shutil
import signal
import datetime

VERSION = '1.0.0'
APP_ID = 'io.jian.Notes'
APP_NAME = '笺'
ROOT = os.path.dirname(os.path.realpath(__file__))
UI_INDEX = os.path.join(ROOT, 'ui', 'index.html')
ICON = os.path.join(ROOT, 'assets', 'jian.png')
TRAY_ICON = os.path.join(ROOT, 'assets', 'jian-tray.svg')
MARGIN = 10          # 窗口阴影留边，需与 style.css 中 --m 一致
CORNER = 18          # 角落缩放热区
HIBERNATE_AFTER = int(os.environ.get('JIAN_HIBERNATE', 20 * 60))  # 隐藏超过这么久（秒）就释放网页进程（约 170MB），只留提醒与托盘


def log(*a):
    print('[jian]', *a, file=sys.stderr, flush=True)


# ───────────────────────── 快速转发（不加载 GTK/WebKit） ─────────────────────────
def forward_to_running(action):
    """若已有实例在运行，把动作转发给它并返回 True。只用 Gio，启动很快。"""
    from gi.repository import Gio, GLib
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        owned = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                              'NameHasOwner', GLib.Variant('(s)', (APP_ID,)), GLib.VariantType('(b)'),
                              Gio.DBusCallFlags.NONE, 800, None).unpack()[0]
        if not owned:
            return False
        pdata = {}
        sid = os.environ.get('DESKTOP_STARTUP_ID')
        if sid:
            pdata['desktop-startup-id'] = GLib.Variant('s', sid)
        bus.call_sync(APP_ID, '/' + APP_ID.replace('.', '/'), 'org.freedesktop.Application', 'ActivateAction',
                      GLib.Variant('(sava{sv})', (action, [], pdata)), None, Gio.DBusCallFlags.NONE, 3000, None)
        return True
    except GLib.Error as e:
        log('forward failed:', e.message)
        return False


def main():
    args = sys.argv[1:]
    if '--version' in args:
        print(f'{APP_NAME} (jian) {VERSION}')
        return 0
    action =('toggle' if '--toggle' in args else 'quit' if '--quit' in args
              else 'mini' if '--mini' in args else 'show')
    if forward_to_running(action):
        return 0
    if action == 'quit':
        return 0

    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    gi.require_version('WebKit2', '4.0')
    from gi.repository import GLib
    GLib.set_prgname(APP_ID)
    GLib.set_application_name(APP_NAME)
    app = make_app(hidden='--hidden' in args, debug='--debug' in args, initial=action)
    return app.run([sys.argv[0]])


def make_app(hidden, debug, initial):
    from gi.repository import Gtk, Gdk, Gio, GLib, WebKit2
    import cairo
    try:
        import gi
        gi.require_version('GdkX11', '3.0')
        from gi.repository import GdkX11
    except (ValueError, ImportError):
        GdkX11 = None

    DATA_DIR = os.path.join(GLib.get_user_data_dir(), 'jian')
    DATA_FILE = os.path.join(DATA_DIR, 'data.json')
    STATE_FILE = os.path.join(DATA_DIR, 'window.json')
    BACKUP_DIR = os.path.join(DATA_DIR, 'backups')
    AUTOSTART_FILE = os.path.join(GLib.get_user_config_dir(), 'autostart', APP_ID + '.desktop')

    # ───────────── 数据 ─────────────
    class Store:
        def __init__(self):
            os.makedirs(BACKUP_DIR, exist_ok=True)
            self.backed_up = None
            self.data = self._load()

        def _load(self):
            candidates = [DATA_FILE] + sorted(
                (os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.endswith('.json')), reverse=True)
            for path in candidates:
                try:
                    with open(path, encoding='utf-8') as f:
                        d = json.load(f)
                    if isinstance(d, dict):
                        if path != DATA_FILE:
                            log('data.json 无法读取，已从备份恢复：', path)
                        return d
                except FileNotFoundError:
                    continue
                except Exception as e:  # 文件损坏：改名留存，绝不覆盖
                    log('读取失败', path, e)
                    if path == DATA_FILE:
                        os.replace(DATA_FILE, DATA_FILE + '.broken-' + time.strftime('%Y%m%d-%H%M%S'))
            return {}

        def save(self, data):
            if not isinstance(data, dict):
                return
            self.data = data
            self._daily_backup()
            tmp = DATA_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, DATA_FILE)

        def _daily_backup(self):
            day = datetime.date.today().isoformat()
            if self.backed_up == day:
                return
            self.backed_up = day
            dst = os.path.join(BACKUP_DIR, f'data-{day}.json')
            if os.path.exists(DATA_FILE) and not os.path.exists(dst):
                shutil.copy2(DATA_FILE, dst)
            olds = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith('data-') and f.endswith('.json'))
            for f in olds[:-14]:          # 只保留最近 14 天
                os.remove(os.path.join(BACKUP_DIR, f))

    def load_state():
        try:
            with open(STATE_FILE, encoding='utf-8') as f:
                s = json.load(f)
                return s if isinstance(s, dict) else {}
        except Exception:
            return {}

    def autostart_enabled():
        return os.path.exists(AUTOSTART_FILE)

    def set_autostart(on):
        if on:
            os.makedirs(os.path.dirname(AUTOSTART_FILE), exist_ok=True)
            with open(AUTOSTART_FILE, 'w', encoding='utf-8') as f:
                f.write('[Desktop Entry]\nType=Application\nName=笺\nComment=在后台待命，准时提醒日程\n'
                        f'Exec=/usr/bin/python3 "{os.path.join(ROOT, "jian.py")}" --hidden\n'
                        f'Icon={ICON}\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=5\n')
        elif os.path.exists(AUTOSTART_FILE):
            os.remove(AUTOSTART_FILE)

    # ───────────── 日程展开（与 app.js 保持一致） ─────────────
    def occurs_on(ev, d):
        ds = d.isoformat()
        start = str(ev.get('date', ''))
        if not start or ds < start or (ev.get('until') and ds > ev['until']):
            return False
        rep = ev.get('repeat', 'none')
        if rep == 'workdays' and d.weekday() >= 5:
            return False
        if rep == 'weekly':
            try:
                if datetime.date.fromisoformat(start).weekday() != d.weekday():
                    return False
            except ValueError:
                return False
        if rep not in ('daily', 'workdays', 'weekly') and ds != start:
            return False
        return ds not in (ev.get('exdates') or [])

    def hm(m):
        return f'{m // 60:02d}:{m % 60:02d}'

    def esc(s):
        return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    # ───────────── 桌面通知 ─────────────
    class Notifier:
        def __init__(self, app):
            self.app = app
            self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            self.pending = {}
            self.bus.signal_subscribe(None, 'org.freedesktop.Notifications', 'ActionInvoked',
                                      '/org/freedesktop/Notifications', None, Gio.DBusSignalFlags.NONE, self._on_action)

        def send(self, summary, body, payload=None):
            hints = {'desktop-entry': GLib.Variant('s', APP_ID), 'urgency': GLib.Variant('y', 1),
                     'sound-name': GLib.Variant('s', 'message-new-instant')}
            params = GLib.Variant('(susssasa{sv}i)', (APP_NAME, 0, ICON, summary, body, ['default', '打开'], hints, -1))

            def done(bus, res):
                try:
                    nid = bus.call_finish(res).unpack()[0]
                    if debug:
                        log('已发送通知', nid, summary)
                    if payload:
                        self.pending[nid] = payload
                except GLib.Error as e:
                    log('通知发送失败', e.message)
            self.bus.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
                          'org.freedesktop.Notifications', 'Notify', params, GLib.VariantType('(u)'),
                          Gio.DBusCallFlags.NONE, -1, None, done)

        def _on_action(self, conn, sender, path, iface, sig, params):
            nid, _key = params.unpack()
            payload = self.pending.pop(nid, None)
            if payload:
                self.app.show()
                self.app.js(f'App.focus({json.dumps(payload["date"])}, {json.dumps(payload["id"])})')

    class Reminder:
        """每 20 秒看一眼接下来的日程；GLib 的秒级定时器会合并唤醒，几乎不耗电。"""
        def __init__(self, app):
            self.app = app
            self.sent = set()
            GLib.timeout_add_seconds(20, self.check)
            GLib.timeout_add_seconds(3, lambda: self.check() and False)

        def check(self):
            try:
                self._check()
            except Exception as e:
                log('提醒检查出错', e)
            return True

        def _check(self):
            data = self.app.store.data or {}
            try:
                lead = int((data.get('settings') or {}).get('remind', 10))
            except (TypeError, ValueError):
                lead = 10
            if lead <= 0:
                return
            now = datetime.datetime.now()
            tasks = data.get('tasks') or []
            for d in (now.date(), now.date() + datetime.timedelta(days=1)):
                for ev in data.get('events') or []:
                    if not isinstance(ev, dict) or ev.get('remind') is False or not occurs_on(ev, d):
                        continue
                    s, e = int(ev.get('start', 0)), int(ev.get('end', 0))
                    start = datetime.datetime.combine(d, datetime.time()) + datetime.timedelta(minutes=s)
                    key = f'{ev.get("id")}@{d}@{s}'
                    if start - datetime.timedelta(minutes=lead) <= now < start and key not in self.sent:
                        self.sent.add(key)
                        left = max(1, round((start - now).total_seconds() / 60))
                        todo = [t for t in tasks if isinstance(t, dict) and t.get('eventId') == ev.get('id')
                                and t.get('date') == d.isoformat() and not t.get('done')]
                        body = f'{left} 分钟后开始 · {hm(s)}–{hm(e)}'
                        if todo:
                            body += '\n' + '\n'.join('☐ ' + esc(t.get('text', '')) for t in todo[:4])
                            if len(todo) > 4:
                                body += f'\n…… 还有 {len(todo) - 4} 项'
                        self.app.notifier.send(esc(ev.get('title') or '未命名日程'), body,
                                               {'date': d.isoformat(), 'id': ev.get('id')})
            if len(self.sent) > 300:
                today = now.date().isoformat()
                self.sent = {k for k in self.sent if k.split('@')[1] >= today}

    # ───────────── 顶栏托盘图标（StatusNotifierItem + dbusmenu） ─────────────
    SNI_XML = '''<node><interface name="org.kde.StatusNotifierItem">
      <property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
      <property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
      <property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
      <property name="IconThemePath" type="s" access="read"/><property name="AttentionIconName" type="s" access="read"/>
      <property name="OverlayIconName" type="s" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
      <property name="ItemIsMenu" type="b" access="read"/><property name="Menu" type="o" access="read"/>
      <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
      <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
      <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
      <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
      <signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewOverlayIcon"/>
      <signal name="NewToolTip"/><signal name="NewStatus"><arg name="status" type="s"/></signal>
    </interface></node>'''
    MENU_XML = '''<node><interface name="com.canonical.dbusmenu">
      <property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
      <property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
      <method name="GetLayout"><arg type="i" name="parentId" direction="in"/><arg type="i" name="recursionDepth" direction="in"/>
        <arg type="as" name="propertyNames" direction="in"/><arg type="u" name="revision" direction="out"/>
        <arg type="(ia{sv}av)" name="layout" direction="out"/></method>
      <method name="GetGroupProperties"><arg type="ai" name="ids" direction="in"/><arg type="as" name="propertyNames" direction="in"/>
        <arg type="a(ia{sv})" name="properties" direction="out"/></method>
      <method name="GetProperty"><arg type="i" name="id" direction="in"/><arg type="s" name="name" direction="in"/>
        <arg type="v" name="value" direction="out"/></method>
      <method name="Event"><arg type="i" name="id" direction="in"/><arg type="s" name="eventId" direction="in"/>
        <arg type="v" name="data" direction="in"/><arg type="u" name="timestamp" direction="in"/></method>
      <method name="EventGroup"><arg type="a(isvu)" name="events" direction="in"/><arg type="ai" name="idErrors" direction="out"/></method>
      <method name="AboutToShow"><arg type="i" name="id" direction="in"/><arg type="b" name="needUpdate" direction="out"/></method>
      <method name="AboutToShowGroup"><arg type="ai" name="ids" direction="in"/><arg type="ai" name="updatesNeeded" direction="out"/>
        <arg type="ai" name="idErrors" direction="out"/></method>
      <signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})" name="updatedProps"/><arg type="a(ias)" name="removedProps"/></signal>
      <signal name="LayoutUpdated"><arg type="u" name="revision"/><arg type="i" name="parent"/></signal>
      <signal name="ItemActivationRequested"><arg type="i" name="id"/><arg type="u" name="timestamp"/></signal>
    </interface></node>'''

    class Tray:
        def __init__(self, app):
            self.app = app
            self.rev = 1
            self.bus = app.get_dbus_connection() or Gio.bus_get_sync(Gio.BusType.SESSION, None)
            sni = Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0]
            menu = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
            self.bus.register_object('/StatusNotifierItem', sni, self._sni_call, self._sni_prop, None)
            self.bus.register_object('/MenuBar', menu, self._menu_call, self._menu_prop, None)
            Gio.bus_watch_name_on_connection(self.bus, 'org.kde.StatusNotifierWatcher',
                                             Gio.BusNameWatcherFlags.NONE, self._register, None)

        def _register(self, conn, name, owner):
            conn.call('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                      'RegisterStatusNotifierItem', GLib.Variant('(s)', (conn.get_unique_name(),)),
                      None, Gio.DBusCallFlags.NONE, -1, None, None)

        def _sni_prop(self, conn, sender, path, iface, prop):
            s = lambda v: GLib.Variant('s', v)
            return {
                'Category': s('ApplicationStatus'), 'Id': s('jian'), 'Title': s(APP_NAME), 'Status': s('Active'),
                'WindowId': GLib.Variant('i', 0), 'IconName': s(TRAY_ICON), 'IconThemePath': s(''),
                'AttentionIconName': s(''), 'OverlayIconName': s(''),
                'ToolTip': GLib.Variant('(sa(iiay)ss)', ('', [], APP_NAME, '双击打开 / 隐藏')),
                'ItemIsMenu': GLib.Variant('b', False), 'Menu': GLib.Variant('o', '/MenuBar'),
            }.get(prop)

        def _sni_call(self, conn, sender, path, iface, method, params, inv):
            if method in ('Activate', 'SecondaryActivate'):
                GLib.idle_add(lambda: self.app.toggle_visible() and False)
            inv.return_value(None)

        def _items(self):
            visible = bool(self.app.win and self.app.win.get_visible())
            return [
                (1, {'label': '隐藏窗口' if visible else '打开笺'}),
                (2, {'label': '迷你置顶卡片', 'toggle-type': 'checkmark', 'toggle-state': int(self.app.mode == 'mini')}),
                (3, {'type': 'separator'}),
                (4, {'label': '退出'}),
            ]

        @staticmethod
        def _props(p):
            return {k: GLib.Variant('i', v) if isinstance(v, int) else GLib.Variant('s', v) for k, v in p.items()}

        def _menu_prop(self, conn, sender, path, iface, prop):
            return {'Version': GLib.Variant('u', 3), 'TextDirection': GLib.Variant('s', 'ltr'),
                    'Status': GLib.Variant('s', 'normal'), 'IconThemePath': GLib.Variant('as', [])}.get(prop)

        def _menu_call(self, conn, sender, path, iface, method, params, inv):
            items = self._items()
            if method == 'GetLayout':
                kids = [GLib.Variant('(ia{sv}av)', (i, self._props(p), [])) for i, p in items]
                root = (0, {'children-display': GLib.Variant('s', 'submenu')}, kids)
                inv.return_value(GLib.Variant('(u(ia{sv}av))', (self.rev, root)))
            elif method == 'GetGroupProperties':
                ids = params.unpack()[0]
                inv.return_value(GLib.Variant('(a(ia{sv}))', ([(i, self._props(p)) for i, p in items if not ids or i in ids],)))
            elif method == 'GetProperty':
                i, name = params.unpack()
                p = dict(items).get(i, {})
                v = p.get(name, '')
                inv.return_value(GLib.Variant('(v)', (GLib.Variant('i', v) if isinstance(v, int) else GLib.Variant('s', v),)))
            elif method == 'Event':
                i, ev_id = params.unpack()[:2]
                if ev_id == 'clicked':
                    GLib.idle_add(self._activate, i)
                inv.return_value(None)
            elif method == 'EventGroup':
                for i, ev_id, _d, _t in params.unpack()[0]:
                    if ev_id == 'clicked':
                        GLib.idle_add(self._activate, i)
                inv.return_value(GLib.Variant('(ai)', ([],)))
            elif method == 'AboutToShow':
                inv.return_value(GLib.Variant('(b)', (False,)))
            elif method == 'AboutToShowGroup':
                inv.return_value(GLib.Variant('(aiai)', ([], [])))
            else:
                inv.return_value(None)

        def _activate(self, i):
            if i == 1:
                self.app.toggle_visible()
            elif i == 2:
                self.app.set_mode(self.app.mode != 'mini')
                self.app.show()
            elif i == 4:
                self.app.quit_app()
            return False

        def update(self):
            self.rev += 1
            try:
                self.bus.emit_signal(None, '/MenuBar', 'com.canonical.dbusmenu', 'LayoutUpdated',
                                     GLib.Variant('(ui)', (self.rev, 0)))
            except GLib.Error:
                pass

    # ───────────── 应用主体 ─────────────
    class JianApp(Gtk.Application):
        def __init__(self):
            super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
            self.start_hidden = hidden
            self.initial = initial
            self.win = None
            self.view = None
            self.ready = False
            self.pending_js = []
            self.store = Store()
            self.state = load_state()
            self.mode = self.state.get('mode') if self.state.get('mode') in ('normal', 'mini') else 'normal'
            self.maximized = False
            self.regions, self.holes = [], []
            self.margin = MARGIN
            self.transparent = True
            self.tray = None
            self.quitting = False
            self._state_timer = 0
            self._hib_timer = 0
            self._show_when_ready = False

        # —— 生命周期 ——
        def do_startup(self):
            Gtk.Application.do_startup(self)
            for name, cb in (('show', lambda *a: self.show()), ('toggle', lambda *a: self.toggle_focus()),
                             ('mini', lambda *a: (self.set_mode(self.mode != 'mini'), self.show())),
                             ('quit', lambda *a: self.quit_app())):
                act = Gio.SimpleAction.new(name, None)
                act.connect('activate', cb)
                self.add_action(act)
            self.set_accels_for_action('app.quit', [])
            self.hold()
            self.notifier = Notifier(self)
            self.reminder = Reminder(self)
            try:
                self.tray = Tray(self)
            except Exception as e:
                log('托盘图标不可用：', e)
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self.quit_app)

        def do_activate(self):
            if self.start_hidden:
                self.start_hidden = False
                return
            if self.initial == 'mini':
                self.initial = None
                self.set_mode(True)
            self.show()

        # —— 窗口 ——
        def ensure_window(self):
            if self.win:
                if not self.view:                 # 从“休眠”中唤醒
                    self.view = self._make_view()
                    self.win.add(self.view)
                    self.view.show()
                return
            win = Gtk.ApplicationWindow(application=self)
            win.set_title(APP_NAME)
            if os.path.exists(ICON):
                win.set_icon_from_file(ICON)
            win.set_decorated(False)
            screen = win.get_screen()
            visual = screen.get_rgba_visual()
            self.transparent = bool(visual and screen.is_composited())
            if self.transparent:
                win.set_visual(visual)
                win.set_app_paintable(True)
                win.connect('draw', self._clear)
            else:
                self.margin = 0
            win.connect('delete-event', lambda *a: (self.hide(), True)[1])
            win.connect('window-state-event', self._on_wstate)
            win.connect('configure-event', self._on_configure)
            self.win = win
            self.view = self._make_view()
            win.add(self.view)
            self._apply_geometry()
            self._apply_pin()

        @staticmethod
        def _clear(widget, cr):
            cr.set_operator(cairo.OPERATOR_SOURCE)
            cr.set_source_rgba(0, 0, 0, 0)
            cr.paint()
            return False

        def _boot_script(self):
            boot = {'data': self.store.data, 'mini': self.mode == 'mini', 'pinned': self.pinned,
                    'autostart': autostart_enabled(), 'opaque': not self.transparent, 'version': VERSION}
            src = 'window.__BOOT__=' + json.dumps(boot, ensure_ascii=False) + ';'
            return WebKit2.UserScript.new(src, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                                          WebKit2.UserScriptInjectionTime.START, None, None)

        def _make_view(self):
            ctx = WebKit2.WebContext.get_default()
            ctx.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)   # 最省内存的缓存策略
            ucm = WebKit2.UserContentManager()
            ucm.register_script_message_handler('bridge')
            ucm.connect('script-message-received::bridge', self._on_message)
            ucm.add_script(self._boot_script())
            self.ucm = ucm
            view = WebKit2.WebView.new_with_user_content_manager(ucm)
            s = view.get_settings()
            s.set_allow_file_access_from_file_urls(True)
            s.set_enable_developer_extras(debug)
            s.set_enable_write_console_messages_to_stdout(debug)
            s.set_enable_page_cache(False)
            s.set_enable_smooth_scrolling(True)
            s.set_javascript_can_open_windows_automatically(False)
            for name in ('set_enable_webgl', 'set_enable_media', 'set_enable_webaudio', 'set_enable_media_stream',
                         'set_enable_mediasource', 'set_enable_encrypted_media'):
                try:
                    getattr(s, name)(False)
                except Exception:
                    pass
            view.set_background_color(Gdk.RGBA(0, 0, 0, 0) if self.transparent else Gdk.RGBA(0.96, 0.94, 0.89, 1))
            view.connect('context-menu', self._on_context_menu)
            view.connect('decide-policy', self._on_policy)
            view.connect('button-press-event', self._on_press)
            view.connect('web-process-terminated', self._on_crash)
            self.index_uri = GLib.filename_to_uri(UI_INDEX)
            view.load_uri(self.index_uri)
            return view

        def _on_crash(self, view, reason):
            log('页面进程退出，重新加载', reason)
            self.ready = False
            self.ucm.remove_all_scripts()
            self.ucm.add_script(self._boot_script())
            view.load_uri(self.index_uri)

        @staticmethod
        def _on_context_menu(view, menu, event, hit):
            return not (hit.context_is_editable() or hit.context_is_selection())

        def _on_policy(self, view, decision, kind):
            if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
                uri = decision.get_navigation_action().get_request().get_uri()
                if uri.split('#')[0] == self.index_uri:
                    return False
                decision.ignore()
                if uri.startswith(('http://', 'https://')):
                    Gio.AppInfo.launch_default_for_uri(uri, None)
                return True
            if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
                decision.ignore()
                return True
            return False

        # 拖动 / 缩放：同步判定，比让网页异步发消息更稳
        def _edge_at(self, x, y):
            if self.maximized:
                return None
            alloc = self.view.get_allocation()
            w, h, g, c = alloc.width, alloc.height, self.margin + 3 if self.margin else 5, CORNER
            l, r, t, b = x < g, x >= w - g, y < g, y >= h - g
            lc, rc, tc, bc = x < c, x >= w - c, y < c, y >= h - c
            E = Gdk.WindowEdge
            if (t and lc) or (l and tc):
                return E.NORTH_WEST
            if (t and rc) or (r and tc):
                return E.NORTH_EAST
            if (b and lc) or (l and bc):
                return E.SOUTH_WEST
            if (b and rc) or (r and bc):
                return E.SOUTH_EAST
            return E.NORTH if t else E.SOUTH if b else E.WEST if l else E.EAST if r else None

        def _in_drag_region(self, x, y):
            inside = lambda rc: rc[0] <= x < rc[0] + rc[2] and rc[1] <= y < rc[1] + rc[3]
            return any(inside(r) for r in self.regions) and not any(inside(r) for r in self.holes)

        def _on_press(self, view, ev):
            if ev.button != 1:
                return False
            single = ev.type == Gdk.EventType.BUTTON_PRESS
            double = ev.type == getattr(Gdk.EventType, 'DOUBLE_BUTTON_PRESS', getattr(Gdk.EventType, '_2BUTTON_PRESS', None))
            edge = self._edge_at(ev.x, ev.y)
            if edge is not None:
                if single:
                    self.win.begin_resize_drag(edge, ev.button, int(ev.x_root), int(ev.y_root), ev.time)
                return True
            if self._in_drag_region(ev.x, ev.y):
                if double and self.mode == 'normal':
                    self.win.unmaximize() if self.maximized else self.win.maximize()
                elif single:
                    self.win.begin_move_drag(ev.button, int(ev.x_root), int(ev.y_root), ev.time)
                return True
            return False

        def _on_wstate(self, win, ev):
            st = ev.new_window_state
            maxed = bool(st & (Gdk.WindowState.MAXIMIZED | Gdk.WindowState.FULLSCREEN))
            if maxed != self.maximized:
                self.maximized = maxed
                self.js(f'App.onWindowState({json.dumps({"maximized": maxed})})')
            return False

        def _on_configure(self, win, ev):
            if not self.maximized and win.get_visible():
                self._record_geometry()
                self._save_state_soon()
            return False

        # —— 几何 / 模式 / 置顶 ——
        @property
        def pinned(self):
            return bool(self.state.get('pin_' + self.mode, self.mode == 'mini'))

        def _workarea(self, x=None, y=None):
            display = Gdk.Display.get_default()
            mon = display.get_monitor_at_point(x, y) if x is not None else None
            mon = mon or display.get_primary_monitor() or display.get_monitor(0)
            return mon.get_workarea()

        def _default_geom(self):
            wa = self._workarea()
            if self.mode == 'mini':
                w, h = 380, min(660, wa.height - 40)
                return [wa.x + wa.width - w - 16, wa.y + 16, w, h]
            w, h = min(1260, wa.width - 60), min(820, wa.height - 60)
            return [wa.x + (wa.width - w) // 2, wa.y + (wa.height - h) // 2, w, h]

        def _apply_geometry(self):
            g = self.state.get(self.mode)
            if not (isinstance(g, list) and len(g) == 4):
                g = self._default_geom()
            x, y, w, h = (int(v) for v in g)
            wa = self._workarea(x + w // 2, y + 20)
            w, h = min(w, wa.width), min(h, wa.height)
            x = max(wa.x - self.margin, min(x, wa.x + wa.width - w + self.margin))
            y = max(wa.y - self.margin, min(y, wa.y + wa.height - h + self.margin))
            geom = Gdk.Geometry()
            geom.min_width, geom.min_height = (300, 360) if self.mode == 'mini' else (840, 560)
            self.win.set_geometry_hints(None, geom, Gdk.WindowHints.MIN_SIZE)
            self.win.resize(w, h)
            gdkwin = self.win.get_window()
            if gdkwin and self.win.get_visible():
                # 已显示的窗口：先立即更新最小尺寸，再把位置和尺寸一次性提交，
                # 否则窗口管理器会按旧尺寸 / 旧限制把位置夹紧
                gdkwin.set_geometry_hints(geom, Gdk.WindowHints.MIN_SIZE)
                gdkwin.move_resize(x, y, w, h)
            else:
                self.win.move(x, y)

        def _record_geometry(self):
            if self.win and self.win.get_visible() and not self.maximized:
                x, y = self.win.get_position()
                w, h = self.win.get_size()
                self.state[self.mode] = [x, y, w, h]

        def _save_state_soon(self):
            if self._state_timer:
                GLib.source_remove(self._state_timer)
            self._state_timer = GLib.timeout_add(800, self._save_state)

        def _save_state(self):
            self._state_timer = 0
            self.state['mode'] = self.mode
            try:
                tmp = STATE_FILE + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(self.state, f)
                os.replace(tmp, STATE_FILE)
            except OSError as e:
                log('保存窗口状态失败', e)
            return False

        def _apply_pin(self):
            if not self.win:
                return
            on = self.pinned
            self.win.set_keep_above(on)
            if on and self.mode == 'mini':
                self.win.stick()          # 迷你置顶时在所有工作区可见
            else:
                self.win.unstick()

        def set_pinned(self, on):
            self.state['pin_' + self.mode] = bool(on)
            self._apply_pin()
            self._save_state_soon()
            self.js(f'App.onWindowState({json.dumps({"pinned": self.pinned})})')

        def set_mode(self, mini):
            new = 'mini' if mini else 'normal'
            if new != self.mode:
                self._record_geometry()
                if self.win and self.maximized:
                    self.win.unmaximize()
                    self.maximized = False
                self.mode = new
                if self.win:
                    self._apply_geometry()
                    self._apply_pin()
                self._save_state_soon()
                if self.tray:
                    self.tray.update()
            GLib.timeout_add(90, self._send_mode)

        def _send_mode(self):
            self.js(f'App.onMode({json.dumps({"mini": self.mode == "mini", "pinned": self.pinned})})')
            return False

        # —— 显示 / 隐藏 ——
        def show(self):
            if self._hib_timer:
                GLib.source_remove(self._hib_timer)
                self._hib_timer = 0
            self.ensure_window()
            if not self.ready and not self.win.get_visible():
                # 页面还没加载好：等它就绪再显示，免得先闪出一个透明空窗
                if not self._show_when_ready:
                    self._show_when_ready = True
                    GLib.timeout_add(1500, self._show_fallback)
                return
            self._really_show()

        def _show_fallback(self):
            if self._show_when_ready:
                self._show_when_ready = False
                self._really_show()
            return False

        def _really_show(self):
            if not self.win.get_visible():
                self._apply_geometry()
                self.win.show_all()
                self._apply_pin()
            ts = Gtk.get_current_event_time()
            gdkwin = self.win.get_window()
            if GdkX11 and isinstance(gdkwin, GdkX11.X11Window):
                ts = GdkX11.x11_get_server_time(gdkwin)
            self.win.present_with_time(ts)
            self.js('App.onShow()')
            if self.tray:
                self.tray.update()

        def hide(self):
            self._show_when_ready = False
            if self.win and self.win.get_visible():
                self._record_geometry()
                self._save_state()
                self.win.hide()
            if self.tray:
                self.tray.update()
            if self.view and not self._hib_timer:
                self._hib_timer = GLib.timeout_add_seconds(HIBERNATE_AFTER, self._hibernate)

        def _hibernate(self):
            self._hib_timer = 0
            view = self.view
            if not view or self.win.get_visible():
                return False

            def release(*_):
                if self.view is not view or self.win.get_visible():
                    return
                self.win.remove(view)
                view.destroy()
                self.view, self.ready, self.pending_js = None, False, []
                log('已休眠：释放网页进程')

            def done(v, res, *_):
                try:
                    self.store.save(json.loads(v.evaluate_javascript_finish(res).to_string()))
                except Exception as e:
                    log('休眠前保存失败，保持运行', e)
                    return
                release()
            if self.ready:
                view.evaluate_javascript('App.dump()', -1, None, None, None, done, None)
            else:
                release()
            return False

        def toggle_visible(self):
            if self.win and self.win.get_visible():
                self.hide()
            else:
                self.show()

        def toggle_focus(self):
            if self.win and self.win.get_visible() and self.win.is_active():
                self.hide()
            else:
                self.show()

        def quit_app(self, *a):
            if self.quitting:
                return True
            self.quitting = True
            self._record_geometry()
            self._save_state()
            if self.view and self.ready:
                def done(view, res, *_):
                    try:
                        self.store.save(json.loads(view.evaluate_javascript_finish(res).to_string()))
                    except Exception as e:
                        log('退出前保存失败', e)
                    self.quit()
                self.view.evaluate_javascript('App.dump()', -1, None, None, None, done, None)
                GLib.timeout_add(2000, lambda: self.quit() or False)
            else:
                self.quit()
            return True

        # —— 网页 ⇄ 原生 ——
        def js(self, code):
            if self.view and self.ready:
                self.view.evaluate_javascript(code, -1, None, None, None, None, None)
            elif self.view:
                self.pending_js.append(code)

        def _on_message(self, ucm, res):
            try:
                msg = json.loads(res.get_js_value().to_string())
            except Exception as e:
                log('无法解析消息', e)
                return
            t = msg.get('type')
            if t == 'save':
                try:
                    self.store.save(msg.get('data'))
                except OSError as e:
                    log('保存失败', e)
            elif t == 'ready':
                self.ready = True
                pending, self.pending_js = self.pending_js, []
                for code in pending:
                    self.js(code)
                if self._show_when_ready:
                    self._show_when_ready = False
                    self._really_show()
            elif t == 'dragRegions':
                self.regions, self.holes = msg.get('regions') or [], msg.get('holes') or []
            elif t == 'hide':
                self.hide()
            elif t == 'minimize':
                self.win.iconify()
            elif t == 'quit':
                self.quit_app()
            elif t == 'setMode':
                self.set_mode(bool(msg.get('mini')))
            elif t == 'setPinned':
                self.set_pinned(bool(msg.get('pinned')))
            elif t == 'setAutostart':
                try:
                    set_autostart(bool(msg.get('on')))
                except OSError as e:
                    log('设置开机自启失败', e)
                self.js(f'App.setAutostart({json.dumps(autostart_enabled())})')
            elif t == 'openDataDir':
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(DATA_DIR), None)

    return JianApp()


if __name__ == '__main__':
    sys.exit(main())
