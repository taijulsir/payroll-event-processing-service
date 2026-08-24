import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request body size limit — production-appropriate protection against oversized request
 * bodies (the only body-accepting route today is `POST /events`; every other route is a GET).
 * Every supported event payload (per-type DTOs in event-types/) is a handful of short strings
 * and numbers, well under 1KB even for the largest type — 64KB leaves generous headroom for
 * unusually long field values while still bounding worst-case abuse far below Express's own
 * 100KB default. Deliberately smaller than that default, not larger.
 *
 * Exported (not just a local const in main.ts) so the e2e test that verifies this limit
 * (test/request-protection.e2e-spec.ts) configures the exact same limit the running app uses,
 * rather than a hand-duplicated copy that could silently drift out of sync.
 */
export const REQUEST_BODY_SIZE_LIMIT = '64kb';

/**
 * Applies {@link REQUEST_BODY_SIZE_LIMIT} to both body-parser content types Nest registers by
 * default (json, urlencoded). Must be called on an app created with `{ bodyParser: false }` —
 * Nest only exposes a way to set a non-default parser limit by opting out of its own
 * auto-registered parsers and registering equivalent ones explicitly (there is no "just change
 * the limit" option on the default ones). Must be called before `app.init()`/`app.listen()`,
 * same as any other body-parser middleware.
 */
export function configureBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: REQUEST_BODY_SIZE_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: REQUEST_BODY_SIZE_LIMIT });
}
