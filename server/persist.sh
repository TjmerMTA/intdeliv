#!/bin/bash
# Зберігання бази між запусками GitHub Actions.
# База лежить у гілці `data` ЛИШЕ зашифрованою (AES-256, ключ — секрет DB_KEY), поруч api.json з адресою тунелю.
#   persist.sh restore            — забрати й розшифрувати базу в $DB_PATH
#   persist.sh save               — стиснути, зашифрувати $DB_PATH і запушити в data
#   persist.sh publish-url <url>  — записати api.json і запушити
#
# Формат: intdeliv.sqlite.gz.enc = gzip → openssl. База стискається в рази, тож файл далекий від межі GitHub
# (100 МіБ на файл), а кожне збереження легше. Старий формат intdeliv.sqlite.enc (без gzip) restore теж читає.
# Перехід: save прибирає старий файл із гілки. Якщо в гілці лежать ОБИДВА — старий записав запуск зі старим кодом
# уже після останнього збереження нового коду, тож він новіший і береться він. Виняток: старий код нового формату
# не бачить і стартує «з нуля»; така база не має спільної історії з новою — тоді береться новий файл (див. lineage).
#
# Нічого не губиться мовчки: недочитана гілка, зіпсований чи обрізаний файл, невдалий push — це помилка з кодом ≠ 0,
# а в гілку потрапляє лише файл, який щойно розшифрувався назад у ту саму базу.
set -euo pipefail
: "${DB_KEY:?DB_KEY не заданий}"
DB_PATH=${DB_PATH:-data/intdeliv.sqlite}
REPO_DIR=$(git rev-parse --show-toplevel)
WT=${PERSIST_WT:-$REPO_DIR/.data-wt}
REMOTE=${PERSIST_REMOTE:-origin}
RETRY_SLEEP=${PERSIST_RETRY_SLEEP:-3}             # база паузи між повторами, с
WARN_BYTES=${PERSIST_WARN_BYTES:-99614720}        # 95 МіБ: GitHub відхиляє файли понад 100 МіБ
NEW_NAME=intdeliv.sqlite.gz.enc
OLD_NAME=intdeliv.sqlite.enc
ENC=(openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass env:DB_KEY)

# тимчасові файли прибираємо за будь-якого виходу; вихід з помилкою без пояснення теж не лишається німим
SNAP=""; PART=""; TMP=""; SAID=0
on_exit() {
  local rc=$?
  [ -z "$SNAP" ] || rm -rf "$SNAP"
  [ -z "$PART" ] || rm -f "$PART"
  [ -z "$TMP" ] || rm -f "$TMP" "$TMP.new"
  if [ "$rc" -ne 0 ] && [ "$SAID" -eq 0 ]; then echo "::error::persist: ${ACTION:-?} перервано з кодом $rc (причина — у рядках вище); гілку data не змінено"; fi
}
trap on_exit EXIT
ACTION=${1:-}
fail() { SAID=1; echo "::error::persist: $*"; exit 1; }
size() { wc -c < "$1" | tr -d ' '; }
is_sqlite() { [ "$(head -c 15 "$1" 2>/dev/null)" = "SQLite format 3" ]; }
dec_new() { "${ENC[@]}" -d -in "$1" | gzip -dc > "$2"; }
dec_old() { "${ENC[@]}" -d -in "$1" -out "$2"; }

# Вміст гілки data → $WT. Гілки ще немає (найперший запуск) — HAS_REMOTE=0. Якщо ж GitHub не відповів, це помилка,
# а не «гілки немає»: інакше restore мовчки стартував би з нуля, а save / publish-url стерли б із гілки сусідній файл.
prepare() {
  git -C "$REPO_DIR" config user.name "intdeliv-bot" 2>/dev/null || true
  git -C "$REPO_DIR" config user.email "intdeliv-bot@users.noreply.github.com" 2>/dev/null || true
  local i rc
  for i in 1 2 3 4; do
    rm -rf "$WT"; mkdir -p "$WT"
    rc=0
    git -C "$REPO_DIR" ls-remote --exit-code "$REMOTE" refs/heads/data >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 2 ]; then HAS_REMOTE=0; return 0; fi
    if [ "$rc" -eq 0 ] && git -C "$REPO_DIR" fetch -q --depth 1 "$REMOTE" data 2>/dev/null \
      && git -C "$REPO_DIR" archive FETCH_HEAD | tar -xf - -C "$WT"; then
      HAS_REMOTE=1; return 0
    fi
    if [ "$i" -lt 4 ]; then sleep $((i * RETRY_SLEEP)); fi
  done
  rm -rf "$WT"
  fail "гілку data не вдалося прочитати ($REMOTE) — нічого не змінюю"
}

# Одна-єдина коміт-версія в гілці data (гілка не росте), push з повтором.
commit_push() {
  local msg=$1 i
  for i in 1 2 3 4 5; do
    local idx; idx=$(mktemp -u)
    GIT_INDEX_FILE=$idx git -C "$REPO_DIR" --work-tree="$WT" add -A .
    local tree; tree=$(GIT_INDEX_FILE=$idx git -C "$REPO_DIR" write-tree)
    rm -f "$idx"
    local c; c=$(git -C "$REPO_DIR" commit-tree "$tree" -m "$msg")
    if git -C "$REPO_DIR" push -q -f "$REMOTE" "$c:refs/heads/data"; then return 0; fi
    if [ "$i" -lt 5 ]; then sleep $((i * RETRY_SLEEP)); fi
  done
  echo "persist: push не вдався" >&2; return 1
}

# Чи є в бази $2 (старий формат) спільна історія з базою $1 (новий формат). Друкує ok | orphan.
# orphan: у новій заявки є, а в старій їх немає зовсім або найдавніша з'явилась пізніше за останню побачену в новій —
# тобто стару базу почато з нуля вже після збереження нової.
lineage() {
  node -e '
const { DatabaseSync } = require("node:sqlite");
const one = (path, sql) => {
  const d = new DatabaseSync(path);
  try { return Object.values(d.prepare(sql).get())[0]; } catch { return null; } finally { d.close(); }
};
const newMax = one(process.argv[1], "SELECT MAX(seenAt) FROM loads");
const oldMin = one(process.argv[2], "SELECT MIN(firstSeenAt) FROM loads");
console.log(newMax !== null && (oldMin === null || oldMin > newMax) ? "orphan" : "ok");' "$1" "$2"
}

case "${1:-}" in
  restore)
    prepare
    NEW="$WT/$NEW_NAME"; OLD="$WT/$OLD_NAME"
    if [ ! -f "$NEW" ] && [ ! -f "$OLD" ]; then
      echo "persist: збереженої бази немає — старт з нуля"
      exit 0
    fi
    mkdir -p "$(dirname "$DB_PATH")"
    # розшифровуємо поруч і лише цілу базу переносимо на місце — обрізаний файл у $DB_PATH не потрапить
    TMP="$DB_PATH.restore.$$"
    FROM=$OLD_NAME
    if [ -f "$OLD" ]; then
      dec_old "$OLD" "$TMP" || fail "не вдалося розшифрувати $OLD_NAME (не той DB_KEY або файл зіпсовано)"
      if [ -f "$NEW" ]; then
        dec_new "$NEW" "$TMP.new" || fail "не вдалося розшифрувати $NEW_NAME (не той DB_KEY або файл зіпсовано)"
        if [ "$(lineage "$TMP.new" "$TMP")" = "orphan" ]; then
          echo "::error::persist: у гілці обидва формати, але $OLD_NAME — база «з нуля» (старий код не прочитав новий формат). Відновлюю $NEW_NAME; зібране запуском зі старим кодом відкинуто"
          mv -f "$TMP.new" "$TMP"; FROM=$NEW_NAME
        else
          echo "::warning::persist: у гілці обидва формати — беру $OLD_NAME: його записав запуск зі старим кодом пізніше"
        fi
      fi
    else
      dec_new "$NEW" "$TMP" || fail "не вдалося розшифрувати $NEW_NAME (не той DB_KEY або файл зіпсовано)"
      FROM=$NEW_NAME
    fi
    is_sqlite "$TMP" || fail "$FROM розшифровано, але це не база SQLite — нічого не відновлюю"
    rm -f "$DB_PATH-wal" "$DB_PATH-shm"
    mv -f "$TMP" "$DB_PATH"
    echo "persist: базу відновлено з $FROM ($(size "$WT/$FROM") → $(size "$DB_PATH") байт)" ;;
  save)
    [ -f "$DB_PATH" ] || { echo "persist: $DB_PATH немає"; exit 0; }
    prepare
    SNAP=$(mktemp -d)
    PART="$WT/$NEW_NAME.part"
    # консистентна копія навіть якщо сервер пише саме зараз
    node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"VACUUM INTO '\"+process.argv[2].replace(/'/g,\"''\")+\"'\")" "$DB_PATH" "$SNAP/db"
    gzip -c "$SNAP/db" > "$SNAP/db.gz"
    "${ENC[@]}" -salt -in "$SNAP/db.gz" -out "$PART"
    # у гілку йде лише файл, який розшифровується назад у ту саму базу байт у байт
    "${ENC[@]}" -d -in "$PART" | gzip -dc | cmp -s - "$SNAP/db" || fail "зашифрований файл не розшифровується назад у ту саму базу — у гілку не пишу"
    mv -f "$PART" "$WT/$NEW_NAME"
    rm -f "$WT/$OLD_NAME"
    BYTES=$(size "$WT/$NEW_NAME")
    echo "persist: розмір бази $(size "$SNAP/db") → gzip $(size "$SNAP/db.gz") → зашифровано $BYTES байт"
    if [ "$BYTES" -gt "$WARN_BYTES" ]; then
      echo "::error::persist: файл бази $BYTES байт — більше за $WARN_BYTES (95 МіБ). GitHub не приймає файли понад 100 МіБ: збереження от-от перестане працювати"
    fi
    commit_push "db $(date -u +%FT%TZ)" || fail "базу НЕ збережено: push у гілку data не вдався (файл $BYTES байт)"
    echo "persist: базу збережено" ;;
  publish-url)
    URL=${2:?url}
    prepare
    printf '{"url":"%s","startedAt":"%s","runId":"%s"}\n' "$URL" "$(date -u +%FT%TZ)" "${GITHUB_RUN_ID:-local}" > "$WT/api.json"
    commit_push "api $URL" || fail "адресу НЕ опубліковано: push у гілку data не вдався"
    echo "persist: адресу опубліковано" ;;
  *) SAID=1; echo "usage: $0 restore|save|publish-url <url>"; exit 2 ;;
esac
