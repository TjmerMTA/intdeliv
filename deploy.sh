#!/bin/bash
# Выкладка админки на GitHub Pages (ветка gh-pages, домен intdeliv.siteboosty.com)
set -euo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d)
cp -R admin/. "$TMP/"
touch "$TMP/.nojekyll"
cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -qm "deploy $(date '+%Y-%m-%d %H:%M')"
git config --local --add credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper osxkeychain
git push -f -q https://github.com/TjmerMTA/intdeliv.git gh-pages
rm -rf "$TMP"
echo "OK: https://intdeliv.siteboosty.com/ (или https://tjmermta.github.io/intdeliv/)"
