#!/usr/bin/env bash
# 「笺」启动器安装脚本
#   ./install.sh               安装启动器，并固定到任务栏（Ubuntu Dock）
#   ./install.sh --uninstall   移除启动器、从任务栏取消固定、关闭开机自启（不会动你的数据）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID="io.jian.Notes"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APPS/$ID.desktop"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/$ID.desktop"

# 在 GNOME 收藏栏（Dock）里加入 / 移除本应用；只改这一项，其它图标保持原样
favorites() {
  local mode="$1"
  command -v gsettings >/dev/null || { echo "未找到 gsettings，跳过任务栏固定"; return; }
  local cur new
  cur="$(gsettings get org.gnome.shell favorite-apps)"
  new="$(/usr/bin/python3 - "$cur" "$ID.desktop" "$mode" <<'PY'
import ast, sys
cur, item, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cur = cur.replace('@as ', '')
apps = list(ast.literal_eval(cur)) if cur.strip() else []
if mode == 'add' and item not in apps:
    apps.append(item)
if mode == 'remove':
    apps = [a for a in apps if a != item]
print(str(apps))
PY
)"
  if [[ "$new" != "$cur" ]]; then
    gsettings set org.gnome.shell favorite-apps "$new"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  /usr/bin/python3 "$DIR/jian.py" --quit || true
  favorites remove
  [[ -f "$DESKTOP" ]] && rm -f -- "$DESKTOP"
  [[ -f "$AUTOSTART" ]] && rm -f -- "$AUTOSTART"
  echo "已卸载启动器。数据仍保存在 ~/.local/share/jian/ 中。"
  exit 0
fi

/usr/bin/python3 -c 'import gi; gi.require_version("WebKit2", "4.0"); from gi.repository import WebKit2' 2>/dev/null || {
  echo "缺少 WebKit2GTK：sudo apt install gir1.2-webkit2-4.0"; exit 1; }

chmod +x "$DIR/jian.py"
mkdir -p "$APPS"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=笺
GenericName=周日程与便签
Comment=一周日程 + 小任务 TODO，常驻后台，随时查看
Exec=/usr/bin/python3 "$DIR/jian.py"
Icon=$DIR/assets/jian.png
Terminal=false
Categories=Office;Calendar;
Keywords=note;todo;schedule;calendar;便签;日程;待办;笺;
StartupNotify=true
StartupWMClass=$ID
Actions=mini;quit;

[Desktop Action mini]
Name=迷你置顶卡片
Exec=/usr/bin/python3 "$DIR/jian.py" --mini

[Desktop Action quit]
Name=退出笺
Exec=/usr/bin/python3 "$DIR/jian.py" --quit
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
favorites add
echo "已安装：$DESKTOP"
echo "已固定到任务栏（Dock）。也可以在「显示应用程序」里搜索「笺」或「便签」。"
