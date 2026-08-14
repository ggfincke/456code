#!/usr/bin/env python3
# scripts/generate-overlay-badges.py
# draw the desktop taskbar overlay badge images from a hand-coded bitmap font

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

# 16px is what a windows taskbar overlay is drawn at; nativeImage cannot
# rasterize svg, so the digits have to be committed as pixels.
SIZE = 16
SUPERSAMPLE = 4
CIRCLE_CENTER = SIZE / 2.0
CIRCLE_RADIUS = 7.9
BADGE_FILL = (220, 38, 38)
GLYPH_FILL = (255, 255, 255)
DEFAULT_OUTPUT = Path("apps/desktop/resources")

# 3x5 digits, one string per row, "1" meaning ink
DIGITS = {
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
}
PLUS = ("010", "111", "010")

OVERFLOW_LABEL = "9+"
LABELS = [str(value) for value in range(1, 10)] + [OVERFLOW_LABEL]


def file_name(label: str) -> str:
    return "overlay-badge-9-plus.png" if label == OVERFLOW_LABEL else f"overlay-badge-{label}.png"


def blit(
    mask: list[list[bool]],
    glyph: tuple[str, ...],
    origin_x: int,
    origin_y: int,
    scale: int,
) -> None:
    for row, bits in enumerate(glyph):
        for column, bit in enumerate(bits):
            if bit != "1":
                continue
            for offset_y in range(scale):
                for offset_x in range(scale):
                    x = origin_x + column * scale + offset_x
                    y = origin_y + row * scale + offset_y
                    if 0 <= x < SIZE and 0 <= y < SIZE:
                        mask[y][x] = True


def glyph_mask(label: str) -> list[list[bool]]:
    mask = [[False] * SIZE for _ in range(SIZE)]
    if label == OVERFLOW_LABEL:
        # the digit keeps the 2x scale it has on its own and the plus rides
        # beside it at 1x; anything larger runs out of the circle at the
        # corners, where a 16px disc has the least room.
        blit(mask, DIGITS["9"], 3, 3, 2)
        blit(mask, PLUS, 10, 6, 1)
    else:
        blit(mask, DIGITS[label], 5, 3, 2)
    return mask


# fraction of the pixel covered by the disc, sampled on a grid so the rim is
# antialiased instead of stair-stepped
def circle_coverage(x: int, y: int) -> float:
    step = 1.0 / SUPERSAMPLE
    inside = 0
    for sample_y in range(SUPERSAMPLE):
        for sample_x in range(SUPERSAMPLE):
            point_x = x + (sample_x + 0.5) * step
            point_y = y + (sample_y + 0.5) * step
            distance_squared = (point_x - CIRCLE_CENTER) ** 2 + (point_y - CIRCLE_CENTER) ** 2
            if distance_squared <= CIRCLE_RADIUS**2:
                inside += 1
    return inside / (SUPERSAMPLE * SUPERSAMPLE)


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)


# 8-bit rgba, no interlace, every scanline on filter type 0
def encode_png(rows: list[bytes]) -> bytes:
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )


def render(label: str) -> bytes:
    mask = glyph_mask(label)
    rows: list[bytes] = []
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            red, green, blue = GLYPH_FILL if mask[y][x] else BADGE_FILL
            row += bytes((red, green, blue, round(circle_coverage(x, y) * 255)))
        rows.append(bytes(row))
    return encode_png(rows)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="write the overlay badge images the desktop taskbar badge reads",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    output = (
        arguments.output if arguments.output.is_absolute() else Path.cwd() / arguments.output
    )
    output.mkdir(parents=True, exist_ok=True)
    for label in LABELS:
        target = output / file_name(label)
        target.write_bytes(render(label))
        print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
