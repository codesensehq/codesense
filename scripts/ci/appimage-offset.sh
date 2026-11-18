#!/bin/bash
# SPDX-License-Identifier: MIT
# Print the byte offset of an AppImage's squashfs image, which follows the ELF runtime, without
# running the runtime. The ELF ends after its section header table: e_shoff + e_shentsize * e_shnum.
# Both Linux targets are 64-bit little-endian ELF; anything else is refused.
#
# Usage: bash scripts/ci/appimage-offset.sh <file.AppImage>
set -euo pipefail
[[ $# -eq 1 && -f "$1" ]] || { echo "usage: $0 <file.AppImage>" >&2; exit 1; }
python3 -c 'import struct, sys
h = open(sys.argv[1], "rb").read(64)
if len(h) < 64 or h[:4] != b"\x7fELF":
    sys.exit(f"Error: {sys.argv[1]} does not start with an ELF header")
if h[4] != 2:
    sys.exit(f"Error: {sys.argv[1]} is not a 64-bit ELF (EI_CLASS {h[4]})")
if h[5] != 1:
    sys.exit(f"Error: {sys.argv[1]} is not a little-endian ELF (EI_DATA {h[5]})")
print(struct.unpack_from("<Q", h, 0x28)[0] + struct.unpack_from("<H", h, 0x3A)[0] * struct.unpack_from("<H", h, 0x3C)[0])' "$1"
