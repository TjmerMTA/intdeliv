#!/bin/bash
# Выкладка админки на GitHub Pages (ветка gh-pages, домен intdeliv.siteboosty.com)
set -euo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d)
cp -R admin/. "$TMP/"
touch "$TMP/.nojekyll"
# сброс кэша: GitHub Pages отдаёт всё с max-age=600, поэтому app.js/style.css подключаются как ?v=<версия>
VER="$(git rev-parse --short HEAD)-$(date +%s)"
sed -i '' "s/?v=dev\"/?v=$VER\"/g" "$TMP/index.html"
grep -q "app.js?v=$VER" "$TMP/index.html" || { echo "не удалось проставить версию в index.html"; exit 1; }
# домен подключаем только когда DNS уже смотрит на GitHub, иначе github.io-ссылка уводит в никуда
if ! dig +short intdeliv.siteboosty.com @ns65.domaincontrol.com | grep -qi "github"; then rm -f "$TMP/CNAME"; echo "DNS intdeliv ещё не настроен — публикую без домена"; fi
cd "$TMP"
git init -q -b gh-pages
git add -A
git commit -qm "deploy $(date '+%Y-%m-%d %H:%M')"
git config --local --add credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper osxkeychain
git push -f -q https://github.com/TjmerMTA/intdeliv.git gh-pages
rm -rf "$TMP"
dig +short intdeliv.siteboosty.com @ns65.domaincontrol.com | grep -qi github && echo "OK: https://intdeliv.siteboosty.com/" || echo "OK: https://tjmermta.github.io/intdeliv/"
