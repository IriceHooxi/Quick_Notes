#!/usr/bin/env bash
# 构建发行包（从 git 提交 / 标签构建，保证和源码完全一致）
#   packaging/build.sh            用 HEAD 构建
#   packaging/build.sh v1.0.0     用指定标签构建
# 产物在 dist/：
#   jian_<版本>_all.deb           Ubuntu / Debian 安装包（sudo apt install ./jian_*.deb）
#   quick-notes-v<版本>.tar.gz     源码包（解压后运行 ./install.sh）
#   SHA256SUMS                    校验和
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-HEAD}"
cd "$ROOT"

VER="$(git show "$REF:jian.py" | sed -n "s/^VERSION = '\(.*\)'$/\1/p")"
[[ -n "$VER" ]] || { echo "无法从 jian.py 读到 VERSION"; exit 1; }
DIST="${DIST:-$ROOT/dist}"          # 可用环境变量 DIST 指定输出目录
mkdir -p "$DIST"
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT      # 只清理本脚本创建的临时目录

# —— 源码包 ——
TAR="$DIST/quick-notes-v$VER.tar.gz"
git archive --format=tar.gz --prefix="quick-notes-v$VER/" -o "$TAR" "$REF"

# —— .deb ——
PKG="$STAGE/jian"
SHARE="$PKG/usr/share/jian"
DOC="$PKG/usr/share/doc/jian"
mkdir -p "$SHARE" "$DOC" "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/usr/share/applications"
git archive "$REF" jian.py ui assets | tar -x -C "$SHARE"
git show "$REF:README.md" > "$DOC/README.md"

for size in 256 128 64 48; do
  src="$SHARE/assets/jian-$size.png"; [[ $size == 256 ]] && src="$SHARE/assets/jian.png"
  install -Dm644 "$src" "$PKG/usr/share/icons/hicolor/${size}x${size}/apps/io.jian.Notes.png"
done
install -Dm644 "$SHARE/assets/jian.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/io.jian.Notes.svg"

cat > "$PKG/usr/bin/jian" <<'EOF'
#!/bin/sh
exec /usr/bin/python3 /usr/share/jian/jian.py "$@"
EOF

cat > "$PKG/usr/share/applications/io.jian.Notes.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=笺
GenericName=周日程与便签
Comment=一周日程 + 小任务 TODO，常驻后台，随时查看
Exec=jian
Icon=io.jian.Notes
Terminal=false
Categories=Office;Calendar;
Keywords=note;todo;schedule;calendar;便签;日程;待办;笺;
StartupNotify=true
StartupWMClass=io.jian.Notes
Actions=mini;quit;

[Desktop Action mini]
Name=迷你置顶卡片
Exec=jian --mini

[Desktop Action quit]
Name=退出笺
Exec=jian --quit
EOF

# 许可证：仓库里有 LICENSE（MIT，Debian 称 Expat）就写入全文；更早的版本没有则注明以仓库为准
if git cat-file -e "$REF:LICENSE" 2>/dev/null; then
  LIC_NAME="Expat"
  LIC_TEXT="$(git show "$REF:LICENSE" | sed -n '/^Permission/,$p' | sed 's/^$/./; s/^/ /')"
else
  LIC_NAME="see-repository"
  LIC_TEXT=" License terms are those stated in the upstream repository."
fi
cat > "$DOC/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Quick_Notes (笺)
Source: https://github.com/IriceHooxi/Quick_Notes

Files: *
Copyright: 2026 IriceHooxi
License: $LIC_NAME

Files: ui/fonts/wenkai/*
Copyright: 2021-2026 LXGW (霞鹜)
License: OFL-1.1
 The full license text is in /usr/share/jian/ui/fonts/wenkai/OFL.txt

License: $LIC_NAME
$LIC_TEXT
EOF

find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod 644 {} +
chmod 755 "$PKG/usr/bin/jian" "$SHARE/jian.py"

cat > "$PKG/DEBIAN/control" <<EOF
Package: jian
Version: $VER
Architecture: all
Maintainer: IriceHooxi <259488130@qq.com>
Installed-Size: $(du -sk --exclude=DEBIAN "$PKG" | cut -f1)
Depends: python3 (>= 3.8), python3-gi, python3-gi-cairo, gir1.2-gtk-3.0, gir1.2-webkit2-4.0
Recommends: gnome-shell-extension-appindicator
Section: utils
Priority: optional
Homepage: https://github.com/IriceHooxi/Quick_Notes
Description: 笺 — 周日程 + 便签 TODO 的桌面小工具
 纸面质感的轻量周日程与待办：七天日程可视化、按时间段分组的小任务、
 日程开始前桌面提醒、迷你置顶卡片、关闭后在后台待命（顶栏托盘图标）。
EOF

DEB="$DIST/jian_${VER}_all.deb"
dpkg-deb --root-owner-group --build "$PKG" "$DEB" >/dev/null

( cd "$DIST" && sha256sum "$(basename "$DEB")" "$(basename "$TAR")" > SHA256SUMS )
echo "构建完成（$REF → v$VER）："
ls -lh "$DEB" "$TAR" "$DIST/SHA256SUMS"
