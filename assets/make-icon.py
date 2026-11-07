#!/usr/bin/env python3
"""生成 assets/icon-180.png（dsh-compat 市场卡片图标）。

零依赖：4x 超采样手绘 + 箱式降采样 + zlib 写 PNG。
图案：深色圆角方块 + 白色菜单卡片（三道菜单项）+ 右下角绿色对勾徽章
（对应「菜单实色 + 加载器隔离」两条功能）。
"""
import struct, zlib

SIZE = 180
S = 4                      # 超采样倍数
W = H = SIZE * S

canvas = bytearray(W * H * 4)   # RGBA，初始全透明


def blend(x, y, r, g, b, a):
    a = a / 255.0
    if a <= 0 or not (0 <= x < W and 0 <= y < H):
        return
    i = (y * W + x) * 4
    sa = canvas[i + 3] / 255.0
    na = min(1.0, a + sa * (1 - a))
    if na <= 0:
        return
    for k, v in enumerate((r, g, b)):
        mixed = (v * a + canvas[i + k] * sa * (1 - a)) / na
        canvas[i + k] = max(0, min(255, int(round(mixed))))
    canvas[i + 3] = max(0, min(255, int(round(na * 255))))


def rounded_rect(x0, y0, x1, y1, rad, color):
    r, g, b, a = color
    x0, y0, x1, y1, rad = (int(v * S) for v in (x0, y0, x1, y1, rad))
    for y in range(max(0, y0), min(H, y1)):
        for x in range(max(0, x0), min(W, x1)):
            dx = max(x0 + rad - x, x - (x1 - rad), 0)
            dy = max(y0 + rad - y, y - (y1 - rad), 0)
            if dx * dx + dy * dy <= rad * rad:
                blend(x, y, r, g, b, a)


def circle(cx, cy, rad, color):
    r, g, b, a = color
    cx, cy, rad = cx * S, cy * S, rad * S
    for y in range(max(0, int(cy - rad)), min(H, int(cy + rad) + 1)):
        for x in range(max(0, int(cx - rad)), min(W, int(cx + rad) + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad:
                blend(x, y, r, g, b, a)


def thick_line(p0, p1, width, color):
    r, g, b, a = color
    x0, y0 = p0[0] * S, p0[1] * S
    x1, y1 = p1[0] * S, p1[1] * S
    hw = width * S / 2
    for y in range(max(0, int(min(y0, y1) - hw)), min(H, int(max(y0, y1) + hw) + 1)):
        for x in range(max(0, int(min(x0, x1) - hw)), min(W, int(max(x0, x1) + hw) + 1)):
            dx, dy = x1 - x0, y1 - y0
            L2 = dx * dx + dy * dy
            t = 0 if L2 == 0 else max(0, min(1, ((x - x0) * dx + (y - y0) * dy) / L2))
            px, py = x0 + t * dx, y0 + t * dy
            if (x - px) ** 2 + (y - py) ** 2 <= hw * hw:
                blend(x, y, r, g, b, a)


BG = (242, 244, 248, 255)
INK = (31, 36, 48, 255)
CARD = (255, 255, 255, 255)
LINE = (58, 66, 84, 255)
GREEN = (46, 204, 113, 255)
WHITE = (255, 255, 255, 255)

# 底：深色圆角方块
rounded_rect(2, 2, 178, 178, 40, INK)
# 菜单卡片
rounded_rect(32, 34, 148, 118, 16, CARD)
# 三道菜单项
thick_line((50, 58), (118, 58), 7, LINE)
thick_line((50, 76), (130, 76), 7, LINE)
thick_line((50, 94), (104, 94), 7, LINE)
# 右下角对勾徽章
circle(138, 134, 27, GREEN)
thick_line((126, 134), (134, 143), 7, WHITE)
thick_line((134, 143), (151, 122), 7, WHITE)


def downsample():
    out = bytearray(SIZE * SIZE * 4)
    n = S * S
    for y in range(SIZE):
        for x in range(SIZE):
            sa = 0
            sr = sg = sb = 0
            for yy in range(y * S, (y + 1) * S):
                for xx in range(x * S, (x + 1) * S):
                    i = (yy * W + xx) * 4
                    a = canvas[i + 3]
                    sa += a
                    sr += canvas[i] * a
                    sg += canvas[i + 1] * a
                    sb += canvas[i + 2] * a
            o = (y * SIZE + x) * 4
            if sa == 0:
                continue
            out[o] = int(round(sr / sa))
            out[o + 1] = int(round(sg / sa))
            out[o + 2] = int(round(sb / sa))
            out[o + 3] = int(round(sa / n))
    return out


def write_png(path, rgba):
    raw = b"".join(b"\x00" + bytes(rgba[y * SIZE * 4:(y + 1) * SIZE * 4]) for y in range(SIZE))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)


write_png("/data/data/com.termux/files/home/code/dsh-compat/assets/icon-180.png", downsample())
print("written")
