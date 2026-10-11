#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=============================================="
echo "  Building Hoster Desktop App for Linux"
echo "=============================================="

# Sync latest src and public
rm -rf src public
cp -r ../src src
cp -r ../public public

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Building AppImage & Debian package..."
npm run build

echo "Build complete! Check dist/ for packages:"
ls -lh dist/*.AppImage dist/*.deb 2>/dev/null || true
