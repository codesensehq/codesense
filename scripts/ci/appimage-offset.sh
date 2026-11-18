#!/bin/bash
# SPDX-License-Identifier: MIT
# Print the byte offset of an AppImage's squashfs image, which follows the ELF runtime, without
# running the runtime. The ELF ends after its section header table: e_shoff + e_shentsize * e_shnum
# (a 64-bit little-endian ELF, as both Linux targets are).
#
# Usage: bash scripts/ci/appimage-offset.sh <file.AppImage>
set -euo pipefail
[[ $# -eq 1 && -f "$1" ]] || { echo "usage: $0 <file.AppImage>" >&2; exit 1; }
python3 -c 'import struct, sys
h = open(sys.argv[1], "rb").read(64)
print(struct.unpack_from("<Q", h, 0x28)[0] + struct.unpack_from("<H", h, 0x3A)[0] * struct.unpack_from("<H", h, 0x3C)[0])' "$1"
