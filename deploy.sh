#!/bin/bash
# Выкладка админки на GitHub Pages (ветка gh-pages, домен intdeliv.siteboosty.com)
set -euo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d)
cp -R admin/. "$TMP/"
touch "$TMP/.nojekyll"
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
[ -f admin/CNAME ] && dig +short intdeliv.siteboosty.com @ns65.domaincontrol.com | grep -qi github && echo "OK: https://intdeliv.siteboosty.com/" || echo "OK: https://tjmermta.github.io/intdeliv/"
