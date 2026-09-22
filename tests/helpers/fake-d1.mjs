// Фейк Cloudflare D1 для тестів: той самий адаптер, що й у сервера, але в пам'яті.
import { D1Database } from '../../server/d1-sqlite.mjs';

export class FakeD1 extends D1Database {
  constructor(schemaPath) { super(':memory:', { schemaPath }); }
}
