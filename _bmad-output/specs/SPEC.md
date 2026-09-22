# SPEC — IntDeliv: автоперенос заявок Della → Lardi + своя база

Статус: v1, 2026-09-22. Заказчица — Софія (логіст/диспетчер). Язык интерфейса — украинский.

## Что строим

1. **Сбор.** Каждые N секунд (по умолчанию 90) забираем свежие заявки Della по поисковым
   ссылкам, которые задала заказчица (или по умолчанию: вся Україна, «прямий замовник», «з вартістю»).
   Фильтруем локально: ціна ≥ `minPrice` (по умолчанию 8000 грн), прямий замовник, типы кузова,
   области откуда/куда (вкл/искл), стоп-слова в грузе. Цель — ~500 новых заявок в день.
2. **База.** Все подходящие заявки кладём в свою базу (IndexedDB расширения). Таблица как на макете
   cargoos.pro: ДАТА | МАРШРУТ (місто → місто, область → область, км) | ВАНТАЖ / АВТО | ВАГА | ОБ'ЄМ |
   ЦІНА (грн, грн/км) | ОПЛАТА | КОМПАНІЯ/статус. Фильтры сверху: «Із міста», «До міста», «Із області»,
   «До області», «Телефон / ID». Неактуальные — серые с 🚫. Можно редактировать и удалять.
3. **Автопубликация** на Lardi **без нажатия «Опублікувати»** — через официальный API Lardi v2
   на **два аккаунта Lardi** (режим `both` по умолчанию, либо `roundrobin`). Очередь с паузой
   между публикациями и дневным лимитом на аккаунт (по умолчанию 500). Если город/кузов не удалось
   сопоставить — не публикуем, статус `needs_review`.
4. **Актуальность.** Заявка неактуальна, если: дата погрузки прошла, или её не видно в выдаче Della
   дольше `staleHours` (по умолчанию 6), или удалена вручную. Неактуальную снимаем с Lardi
   (`POST /proposals/my/basket/throw`).

## Архитектура (без своих серверов)

- `extension/` — Chrome MV3 расширение. Service worker делает всю работу: fetch Della (публичный
  HTML, host_permissions), разбор строками/regex (в SW нет DOMParser), вызовы Lardi API (CORS у
  Lardi закрыт — только из SW с host_permissions), очередь, IndexedDB, chrome.alarms.
- `admin/` — статическая админка (GitHub Pages, `intdeliv.siteboosty.com`). Без сборки: один
  `index.html` + `app.js` + `style.css`. Данные получает от расширения через мост.
- **Мост:** content script `bridge.js` расширения внедряется в страницы админки
  (`https://intdeliv.siteboosty.com/*`, `https://tjmermta.github.io/*`, `http://localhost/*`,
  `http://127.0.0.1/*`) и пересылает сообщения `window.postMessage` ↔ `chrome.runtime.sendMessage`.
  Если расширение не найдено за 1.5 с — админка показывает инструкцию по установке и демо-данные.

## Контракт моста

Страница → расширение:
```js
window.postMessage({ __intdeliv: 'req', id: '<uuid>', method: 'loads.list', params: {...} }, '*')
```
Расширение → страница:
```js
{ __intdeliv: 'res', id, ok: true, result } | { __intdeliv: 'res', id, ok: false, error: 'text' }
{ __intdeliv: 'event', type: 'loads.changed' | 'status', data }   // пуш без запроса
{ __intdeliv: 'hello', version }                                     // при загрузке bridge.js
```

Методы:
| method | params | result |
|---|---|---|
| `ping` | – | `{version}` |
| `loads.list` | `{fromCity?, toCity?, fromRegion?, toRegion?, q?, status?, limit?=500, offset?=0}` | `{items: Load[], total}` (сорт. по `seenAt` desc) |
| `loads.update` | `{id, patch: Partial<Load>}` | `Load` (если опубликована — `PUT` на Lardi) |
| `loads.delete` | `{id, fromLardi?: true}` | `{ok}` |
| `loads.publish` | `{id}` | `Load` — поставить в очередь вне автомата |
| `loads.unpublish` | `{id}` | `Load` |
| `settings.get` | – | `Settings` (токены маскированы `••••1234`) |
| `settings.set` | `Partial<Settings>` | `Settings` |
| `status.get` | – | `Status` |
| `sync.now` | – | `{started: true}` |
| `lardi.test` | `{accountIndex}` | `{ok, name?, error?}` |
| `log.list` | `{limit?=200}` | `LogEntry[]` |

## Модели

```ts
type Load = {
  id: string;              // 'd_' + sha1(fingerprint) — ID Della шифруется на каждый запрос, поэтому отпечаток
  fingerprint: string;     // fromCityId|toCityId|cargo|weight|price|dateFrom
  source: 'della';
  dateFrom: string;        // 'YYYY-MM-DD'
  dateTo?: string;
  fromCity: string; fromRegion: string; fromCityId?: string;   // cityId Della
  toCity: string;   toRegion: string;   toCityId?: string;
  distanceKm?: number;
  cargo: string;           // 'запчастини на палетах'
  body: string;            // 'тент' | 'рефрижератор' | ...
  weight?: number;         // т
  volume?: number;         // м³
  price?: number;          // грн
  pricePerKm?: number;
  currency: 'UAH' | 'USD' | 'EUR';
  payment?: string;        // 'Безнал' | 'Картка' | 'Готівка' ...
  tags: string[];          // «Довантаження», «Кільк. палет: 8» ...
  directCustomer: boolean;
  company?: string; phone?: string;   // если видны (у залогиненной сессии)
  dellaUrl?: string;
  status: 'new' | 'queued' | 'published' | 'needs_review' | 'error' | 'inactive' | 'deleted';
  statusReason?: string;
  lardi: { account: number; id?: number; status?: string; error?: string }[];
  seenAt: number; firstSeenAt: number; updatedAt: number;
  edited?: boolean;        // правки руками — не перезатирать при повторном сборе
};

type Settings = {
  della: { searchUrls: string[]; pollSeconds: number; pagesPerPoll: number };
  filters: { minPrice: number; directOnly: boolean; bodies: string[]; fromRegions: string[];
             toRegions: string[]; excludeRegions: string[]; stopWords: string[]; maxAgeHours: number };
  lardi: { accounts: { name: string; token: string; enabled: boolean }[];
           mode: 'both' | 'roundrobin'; autoPublish: boolean; dryRun: boolean;
           intervalSeconds: number; dailyLimit: number; note: string };
  staleHours: number;
};

type Status = { running: boolean; lastPollAt?: number; lastError?: string;
  counts: Record<Load['status'], number>; today: { collected: number; published: number[] };
  queue: number };
type LogEntry = { t: number; level: 'info' | 'warn' | 'error'; msg: string };
```

По умолчанию `dryRun: true` — первую неделю «показать, что будет опубліковано», потом выключить.

## Della: как читать выдачу (проверено 22.09.2026)

- URL поиска: `https://della.com.ua/search/<params>.html`, страницы — суффикс `r{offset}l25`
  перед `.html` (25 на страницу, больше нельзя). Пример: вся UA, прямий замовник, з вартістю:
  `a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1` (+ `r25l25` для стр. 2).
  Маски: `a<країна>b<регіони>d<країна>e<регіони>`, `z2`=прямий замовник, `z5`=маска оплати
  (1 з вартістю,16 безнал,32 готівка,64 картка), `z6`=час додавання.
- Карточка: `<div class="request_card ..." data-request_id="...">`. Внутри: `.date_add` («22.09» или
  «22.09–22.11»), `.truck_type`, `.weight` («6,9 т»), `.request_route` — два
  `<span title="Рівненський р-н, Рівненська обл."><span class="locality">Рівне </span>(UA)</span>`,
  `href="/distance/?cities=5047,5224..."` (ID городов Della), `.distance` («438 км»),
  `.cargo_type`, `.request_tags .tag`, `.price_main` («20 000 грн», с `&nbsp;`/span), `.price_additional`
  («45,66 грн/км»), `.price_tags`, прямий замовник — наличие `is_zirka_img`.
- Фикстура: `tests/fixtures/della-search.html`.

## Lardi API v2 (docs: https://api.lardi-trans.com/v2/docs/en/)

- Base `https://api.lardi-trans.com/v2`, заголовок `Authorization: <token>` (без Bearer),
  `?language=uk`. Токен — lardi-trans.com → Налаштування → API.
- Добавить: `POST /proposals/my/add/cargo` → `{id}`. Обязательные: `dateFrom`, `paymentValue`
  (в примере доков `paymentPrice` — слать оба), `paymentCurrencyId` (2=UAH,4=USD,6=EUR),
  `cargoBodyTypeIds[]`, `sizeMass`, `waypointListSource[]`, `waypointListTarget[]`,
  `contentName`. Точки: `{countrySign:'UA', townId?, townName, areaId?}`.
- Изменить: `PUT /proposals/my/cargo/{status}/{id}`. Список: `GET /proposals/my/cargoes/published?page=1&size=100`.
  Снять: `POST /proposals/my/basket/throw` `{cargoIds:[..], lorryIds:[]}`.
- Справочники: `GET /references/towns/by/name?query=харк&countrySigns=UA&limit=10` (≥3 символов),
  `GET /references/body/types`, `GET /references/payment/types` (2 готівка, 4 безнал, 10 картка).
- 429 — ретрай с backoff. Кэшировать сопоставления город→townId и кузов→id в IndexedDB.

## Не делаем в v1

Обратное направление Lardi → Della (у Della нет API; только через форму — v2). Контакты
заказчика из Della (скрыты капчей) — на Lardi публикуем с контактами владельца токена.
