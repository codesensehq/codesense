#!/bin/bash
# SPDX-License-Identifier: MIT
# Install the system libraries the Tauri app links against on Linux: WebKitGTK, the tray indicator,
# SVG icons, D-Bus for the keyring, xdo for input, and OpenSSL. Extra packages named on the command
# line are installed with them. One list for every Linux job that builds the app.
# Usage: scripts/install-linux-app-libs.sh [extra-package ...]
set -euo pipefail
sudo apt-get update
sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev libxdo-dev libssl-dev "$@"
