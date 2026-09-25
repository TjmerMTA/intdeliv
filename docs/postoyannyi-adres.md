# Постоянный адрес сервера IntDeliv

## Зачем это нужно

Сейчас админка связывается с сервером через временный адрес вида `….trycloudflare.com`.
Он меняется каждые ~6 часов, и у части пользователей его блокирует интернет-провайдер
или антивирус: так случилось у заказчицы, у неё админка бесконечно грузится.

Решение — постоянный адрес на нашем домене: **`https://api.intdeliv.siteboosty.com`**.
Его никто не блокирует, и он не меняется.

- **Стоимость:** 0. Всё на бесплатном тарифе Cloudflare.
- **Время:** 15–20 минут вашей работы, потом до нескольких часов ожидания (без вашего участия).
- **Что понадобится:** своя почта, вход в GoDaddy (там куплен домен siteboosty.com).

Сайты на siteboosty.com всё это время продолжают работать.

---

## Шаг 1. Завести бесплатный аккаунт Cloudflare и добавить домен

1. Откройте https://dash.cloudflare.com/sign-up и зарегистрируйтесь: почта и пароль.
   Пароль придумайте свой и **никому не пересылайте**, даже исполнителю.
2. Подтвердите почту по ссылке из письма Cloudflare.
3. В кабинете нажмите **«Add a domain»** (или «Добавить сайт»), впишите `siteboosty.com`,
   нажмите **Continue**.
4. Выберите тариф **Free** (обычно он в самом низу списка, цена $0) и нажмите **Continue**.
   Платные тарифы не нужны.
5. Cloudflare покажет список найденных записей домена. Сверьте его с таблицей ниже.
   Если какой-то записи нет, добавьте её кнопкой **«Add record»**.

   | Тип   | Имя (Name)   | Значение (Content)              |
   |-------|--------------|---------------------------------|
   | A     | `siteboosty.com` (или `@`) | `185.199.108.153` |
   | A     | `siteboosty.com` (или `@`) | `185.199.109.153` |
   | A     | `siteboosty.com` (или `@`) | `185.199.110.153` |
   | A     | `siteboosty.com` (или `@`) | `185.199.111.153` |
   | CNAME | `www`        | `tjmermta.github.io`            |
   | CNAME | `dev`        | `tjmermta.github.io`            |
   | CNAME | `intdeliv`   | `tjmermta.github.io`            |
   | TXT   | `_dmarc`     | `v=DMARC1; p=quarantine; …` (как есть) |

6. **Важно:** у каждой записи есть переключатель-облачко («Proxy status»).
   Сделайте его **серым («DNS only»)** у всех записей из таблицы.
   Если облачко оранжевое, сайты на GitHub могут перестать открываться.
7. Нажмите **Continue**. Cloudflare покажет **два адреса** вида
   `имя.ns.cloudflare.com` — это «серверы имён». Скопируйте их или оставьте вкладку открытой,
   они нужны в шаге 2.

## Шаг 2. Переключить домен на Cloudflare в GoDaddy

1. Войдите в GoDaddy → **«Мои продукты»** (My Products) → **Домены** → `siteboosty.com`.
2. Откройте раздел **DNS** → вкладка **«Серверы имён»** (Nameservers).
3. Нажмите **«Изменить серверы имён»** (Change Nameservers) → выберите вариант
   **«Я буду использовать свои серверы имён»** (I'll use my own nameservers).
4. Удалите старые `ns65.domaincontrol.com` и `ns66.domaincontrol.com`
   и впишите **два адреса из шага 1** (по одному в поле).
5. Нажмите **«Сохранить»** и подтвердите предупреждение: GoDaddy честно пишет,
   что управление записями переедет. Так и нужно.
6. Ждите. Обычно это занимает от 15 минут до 2 часов, изредка до суток. Когда всё
   переключится, Cloudflare пришлёт письмо, что сайт `siteboosty.com` активен
   (в кабинете у домена появится статус **Active**).

Если GoDaddy спросит про **DNSSEC**, он должен быть **выключен**. Сейчас он выключен,
отдельно ничего делать не нужно.

## Шаг 3. Выдать исполнителю ключ доступа (токен)

Токен — это отдельный ключ с ограниченными правами: только для туннеля и записей
домена siteboosty.com. Пароль от аккаунта исполнитель при этом не получает, а токен
можно в любой момент отозвать.

1. В Cloudflare справа вверху нажмите на значок профиля → **My Profile** → слева **API Tokens**.
2. Нажмите **Create Token** → внизу **Create Custom Token** → **Get started**.
3. **Token name:** `IntDeliv tunnel`.
4. **Permissions** — три строки (кнопка «+ Add more» добавляет строку):

   | Первое поле | Второе поле       | Третье поле |
   |-------------|-------------------|-------------|
   | Account     | Cloudflare Tunnel | Edit        |
   | Zone        | DNS               | Edit        |
   | Zone        | Zone              | Read        |

5. **Account Resources:** `Include` → ваш аккаунт.
   **Zone Resources:** `Include` → `Specific zone` → `siteboosty.com`.
6. Остальное не трогайте → **Continue to summary** → **Create Token**.
7. Cloudflare **один раз** покажет длинную строку — это и есть токен. Скопируйте её.
8. Передайте токен исполнителю **не открытым текстом** в чате или почте. Подойдёт
   одноразовая ссылка (например, https://onetimesecret.com) или менеджер паролей.

Отозвать токен: там же, в **API Tokens** → у токена меню «…» → **Delete**.

---

## Что будет дальше (делает исполнитель, ~1 час)

1. Создаёт в вашем Cloudflare постоянный туннель и адрес `api.intdeliv.siteboosty.com`.
2. Кладёт ключ туннеля в секреты GitHub (`CF_TUNNEL_TOKEN`) и адрес в переменную (`API_URL`).
   Код для этого уже готов в ветке `permanent-tunnel`; после вашего согласия он вливается в основную.
3. Перезапускает сервер: 1–2 минуты простоя. Админка сама узнает новый адрес,
   у пользователей ничего делать не нужно.
4. Проверяет вход и нажимает «Діагностика з'єднання». То же попросим сделать заказчицу:
   у неё все строки должны стать зелёными.

---

## Для исполнителя

**Сохранить токен** (без показа на экране; команда спросит значение):

```bash
security add-generic-password -a intdeliv -s intdeliv-cf-token -w
```

**Настройка через API** (`TOKEN=$(security find-generic-password -s intdeliv-cf-token -w)`):

1. `GET /accounts` → `ACCOUNT_ID`; `GET /zones?name=siteboosty.com` → `ZONE_ID`, статус `active`.
2. `POST /accounts/$ACCOUNT_ID/cfd_tunnel` `{"name":"intdeliv","config_src":"cloudflare"}` → `TUNNEL_ID`.
3. `PUT /accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations`
   `{"config":{"ingress":[{"hostname":"api.intdeliv.siteboosty.com","service":"http://localhost:8787"},{"service":"http_status:404"}]}}`.
4. `POST /zones/$ZONE_ID/dns_records`
   `{"type":"CNAME","name":"api.intdeliv","content":"$TUNNEL_ID.cfargotunnel.com","proxied":true}`.
5. `GET /accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token` → `gh secret set CF_TUNNEL_TOKEN`;
   `gh variable set API_URL --body https://api.intdeliv.siteboosty.com`.
6. Влить ветку `permanent-tunnel` в main (только с согласия владельца). Запуск в Actions держит старый код до
   перезапуска: отменить текущий запуск и выполнить `gh workflow run engine`.
7. Проверить `curl https://api.intdeliv.siteboosty.com/` → `{"name":"intdeliv","ok":true}`,
   затем вход в админку и «Діагностика з'єднання».

Без секрета `CF_TUNNEL_TOKEN` workflow работает по-старому (quick tunnel). Откат — удалить секрет.
Cloudflare-аккаунт Shifton для этого **не использовать**.
