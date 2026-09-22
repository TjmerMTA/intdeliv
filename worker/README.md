# IntDeliv — хмарний рушій (Cloudflare Worker)

Працює сам, без Chrome: щохвилини (cron) забирає заявки Della, фільтрує, зберігає в D1 і
публікує на Lardi (за замовчуванням **DRY RUN** — нічого не публікується). Адмінка звертається
до `POST /api/rpc` з заголовком `Authorization: Bearer <ADMIN_KEY>`.

## Розгортання

```bash
cd worker
npx wrangler login
npx wrangler d1 create intdeliv            # скопіюйте database_id
# вставте id у wrangler.toml замість REPLACE_ME
npx wrangler d1 execute intdeliv --remote --file schema.sql
npx wrangler secret put ADMIN_KEY          # довгий випадковий ключ; його ж вводимо в адмінці
npx wrangler deploy
```

Перевірка: `curl https://intdeliv.<акаунт>.workers.dev/` → `{"name":"intdeliv","ok":true}`.
Журнал у реальному часі: `npx wrangler tail`.

## Нотатки

- Потрібен план **Workers Paid** ($5/міс): на безкоштовному — 10 мс CPU і 50 підзапитів на запуск,
  цього замало для розбору кількох сторінок Della та викликів Lardi.
- Крок cron — 1 хвилина, тож `pollSeconds` < 60 фактично означає «щохвилини».
- Бібліотеки розбору/фільтрів/Lardi спільні з розширенням (`../extension/lib`).
- Тести: `node --test tests/*.test.mjs` у корені репозиторію (Node 22+).
