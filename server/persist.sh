#!/bin/bash
# Зберігання бази між запусками GitHub Actions.
# База лежить у гілці `data` ЛИШЕ зашифрованою (AES-256, ключ — секрет DB_KEY), поруч api.json з адресою тунелю.
#   persist.sh restore            — забрати й розшифрувати базу в $DB_PATH
#   persist.sh save               — зашифрувати $DB_PATH і запушити в data
#   persist.sh publish-url <url>  — записати api.json і запушити
set -euo pipefail
: "${DB_KEY:?DB_KEY не заданий}"
DB_PATH=${DB_PATH:-data/intdeliv.sqlite}
REPO_DIR=$(git rev-parse --show-toplevel)
WT=${PERSIST_WT:-$REPO_DIR/.data-wt}
REMOTE=${PERSIST_REMOTE:-origin}

prepare() {
  git -C "$REPO_DIR" config user.name "intdeliv-bot" 2>/dev/null || true
  git -C "$REPO_DIR" config user.email "intdeliv-bot@users.noreply.github.com" 2>/dev/null || true
  rm -rf "$WT"; mkdir -p "$WT"
  if git -C "$REPO_DIR" fetch -q --depth 1 "$REMOTE" data 2>/dev/null; then
    git -C "$REPO_DIR" --work-tree="$WT" checkout -q FETCH_HEAD -- . 2>/dev/null || true
    HAS_REMOTE=1
  else
    HAS_REMOTE=0
  fi
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
    sleep $((i * 3))
  done
  echo "persist: push не вдався" >&2; return 1
}

case "${1:-}" in
  restore)
    prepare
    mkdir -p "$(dirname "$DB_PATH")"
    if [ -f "$WT/intdeliv.sqlite.enc" ]; then
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:DB_KEY -in "$WT/intdeliv.sqlite.enc" -out "$DB_PATH"
      echo "persist: базу відновлено ($(wc -c < "$DB_PATH") байт)"
    else
      echo "persist: збереженої бази немає — старт з нуля"
    fi ;;
  save)
    [ -f "$DB_PATH" ] || { echo "persist: $DB_PATH немає"; exit 0; }
    prepare
    # консистентна копія навіть якщо сервер пише саме зараз
    SNAP=$(mktemp)
    node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(\"VACUUM INTO '\"+process.argv[2].replace(/'/g,\"''\")+\"'\")" "$DB_PATH" "$SNAP.db"
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:DB_KEY -in "$SNAP.db" -out "$WT/intdeliv.sqlite.enc"
    rm -f "$SNAP" "$SNAP.db"
    commit_push "db $(date -u +%FT%TZ)"
    echo "persist: базу збережено" ;;
  publish-url)
    URL=${2:?url}
    prepare
    printf '{"url":"%s","startedAt":"%s","runId":"%s"}\n' "$URL" "$(date -u +%FT%TZ)" "${GITHUB_RUN_ID:-local}" > "$WT/api.json"
    commit_push "api $URL"
    echo "persist: адресу опубліковано" ;;
  *) echo "usage: $0 restore|save|publish-url <url>"; exit 2 ;;
esac
