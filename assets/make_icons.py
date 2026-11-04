#!/usr/bin/python3
"""把 jian.svg 渲染成各尺寸 PNG（修改图标后运行一次即可）。"""
import os
import gi
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf

here = os.path.dirname(os.path.realpath(__file__))
src = os.path.join(here, 'jian.svg')
for size in (256, 128, 64, 48):
    pb = GdkPixbuf.Pixbuf.new_from_file_at_size(src, size, size)
    name = 'jian.png' if size == 256 else f'jian-{size}.png'
    pb.savev(os.path.join(here, name), 'png', [], [])
    print('wrote', name)
