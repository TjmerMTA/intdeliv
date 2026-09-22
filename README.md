# IntDeliv — заявки Della → Lardi

Сам збирає свіжі заявки Della (ціна від 8000, прямий замовник тощо), складає в базу й автоматично
публікує на два акаунти Lardi через офіційний API. Без Chrome, без серверів і сторонніх акаунтів.

- **Адмінка:** https://intdeliv.siteboosty.com/ (GitHub Pages, гілка `gh-pages`, `./deploy.sh`).
- **Рушій:** GitHub Actions (`.github/workflows/engine.yml`) — працює безперервно, щохвилини опитує Della.
  API віддається через безкоштовний тунель trycloudflare (без акаунта); адмінка бере адресу з `api.json` у гілці `data`.
- **База:** SQLite, між запусками зберігається в гілці `data` лише зашифрованою (секрет `DB_KEY`).

Секрети репозиторію: `ADMIN_KEY` (ключ входу в адмінку), `DB_KEY` (шифрування бази),
`LARDI_TOKEN_1`, `LARDI_TOKEN_2` (необовʼязково — токени можна вписати в налаштуваннях адмінки).
Ручний запуск: Actions → engine → Run workflow.

Код: `extension/lib` — спільні модулі (парсер Della, клієнт Lardi, фільтри), `worker/src` — рушій і RPC,
`server/` — запуск рушія в Node + збереження бази, `admin/` — адмінка. Тести: `node --test tests/*.test.mjs`.
