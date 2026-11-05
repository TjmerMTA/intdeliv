// Фейкова Della «з входом». Справжньої залогіненої сторінки в нас немає (сесії Della немає) — усе нижче
// похідне від збереженої анонімної видачі tests/fixtures/della-search.html. На ній доведено лише ознаки
// «без входу»: <div id="unlogged_div" style="display:block;"> із кнопкою «Вхід» у шапці та «Докладніше»
// у картці → onclick="register();". «Вхід є» тут = ці дві ознаки вимкнено; замовник у картці — там і так,
// як його шукає парсер (data-company-code / data-company-name, телефон і ЄДРПОУ в тексті картки).
// Якщо справжня залогінена верстка інша — це покаже della.session.check на живій сесії, а не ці тести.
import { HTML } from './harness.mjs';

/** Та сама видача, але «з входом»: шапка без «Вхід», «Докладніше» не веде на реєстрацію. */
export function asLoggedIn(html = HTML) {
  return html
    .replace(/<div id="unlogged_div" style="display:block;">/, '<div id="unlogged_div" style="display:none;">')
    .replace(/(class="show_request_info_btn"\s+onclick=")register\(\);?(")/g, '$1showRequestInfo(this);$2');
}

/**
 * Замовник у картках: pick(i) → {code?, name?, phone?, edrpou?} | null для i-ї картки.
 * Код і назва — атрибутами картки, телефон і ЄДРПОУ — текстом усередині картки.
 */
export function withCustomers(html, pick) {
  let i = -1;
  return html.replace(/(<div class="request_card(?:\s[^"]*)?"\s+data-request_id="[^"]*")([^>]*>)/g, (m, open, rest) => {
    i++;
    const c = pick(i);
    if (!c) return m;
    const attrs = (c.code ? ` data-company-code="${c.code}"` : '') + (c.name ? ` data-company-name="${c.name}"` : '');
    const text = [c.phone, c.edrpou && `ЄДРПОУ: ${c.edrpou}`].filter(Boolean).join(' · ');
    return `${open}${attrs}${rest}${text ? `<div class="request_contacts">${text}</div>` : ''}`;
  });
}

const cardIds = (html) => [...html.matchAll(/<div class="request_card(?:\s[^"]*)?"\s+data-request_id="([^"]*)"/g)].map((m) => m[1]);

/**
 * Код і назва компанії так, як їх читає JS самої Della («сховати компанію», hideRequestOrCompany, живий 05.11.2026):
 * елемент #hide_request_or_company_hidden_<request_code> з data-company-code / data-company-name. Де він стоїть
 * у справжній сторінці — не бачили, тож тут навмисно поза карткою (наприкінці сторінки).
 */
export function withHiddenCompanies(html, pick) {
  const els = cardIds(html).map((rid, i) => {
    const c = pick(i);
    return c ? `<select id="hide_request_or_company_hidden_${rid}" data-company-code="${c.code}" data-company-name="${c.name}"></select>` : '';
  }).join('');
  return html.replace('</body>', `${els}</body>`);
}

/**
 * Кнопка контактів у картці з вбудованим викликом companyDrawContacts(...) — сигнатура з JS Della (живий, 05.11.2026);
 * сам вигляд кнопки і значення аргументів (крім r_c = request_code) вигадані: залогіненої картки не бачили.
 */
export function withContactsCall(html) {
  return html.replace(/(<div class="request_card(?:\s[^"]*)?"\s+data-request_id="([^"]*)"[^>]*>)/g,
    (m, open, rid) => `${open}<div class="show_contacts_btn" onclick="companyDrawContacts(['phones','emails'], 'em1', 1, 0, 0, 0, 0, 'G7', '${rid}', 'l25', 3, !1)">Показати контакти</div>`);
}
