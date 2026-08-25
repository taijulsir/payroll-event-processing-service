import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureBodyParser } from './http-bootstrap';

async function bootstrap() {
  // `bodyParser: false` + configureBodyParser() (rather than Nest's default-registered
  // parsers) is the documented way to apply a non-default body size limit — see
  // http-bootstrap.ts for the limit value and full rationale. NestExpressApplication (not the
  // generic INestApplication) is required for `useBodyParser` to be available.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureBodyParser(app);
  app.use(helmet());

  // CORS: the frontend is a static export that calls this API directly from the browser
  // (frontend/lib/api.ts), never from inside a Docker container — so this must be the
  // browser-reachable origin the frontend is actually served from, not a Compose-internal
  // hostname. `FRONTEND_ORIGIN` follows this codebase's existing convention for
  // environment-driven config (plain `process.env.X` reads, e.g. REDIS_HOST in
  // redis-connection.provider.ts) rather than introducing NestJS's ConfigService, which
  // nothing else in this codebase uses either. Defaults to `http://localhost:3001` — this
  // service's own established local/Docker Compose frontend port (docker-compose.yml's
  // `frontend` service: `${FRONTEND_PORT:-3001}:80`) — so the common case needs no override.
  // An explicit allowlisted origin, not `origin: '*'`/`origin: true`: the frontend never
  // sends credentials (no `credentials: 'include'` in its fetch calls), so this isn't closing
  // a credential-theft hole, but an explicit origin is still the correct minimum here — it
  // costs nothing and avoids the API reflecting an arbitrary caller-supplied Origin back as
  // trusted, which `enableCors()`'s previous no-argument form did.
  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001';
  app.enableCors({ origin: frontendOrigin, credentials: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Minimal Swagger setup (assignment "API Documentation": Swagger/OpenAPI preferred).
  // @nestjs/swagger has been an installed dependency since Phase 1; this just turns it on
  // for the endpoints that exist so far — no custom theming/config beyond the essentials.
  const swaggerConfigBuilder = new DocumentBuilder()
    .setTitle('Payroll Event Processing Service')
    .setDescription('API for submitting and tracking payroll events')
    .setVersion('0.1.0');

  // Without an explicit `servers` entry, Swagger UI's "Try it out" targets the current page's
  // own origin with no path prefix — fine locally (routes are reached directly, unprefixed),
  // but wrong behind a reverse proxy that only exposes this API under a path prefix (e.g.
  // production's `/api`): requests would miss the proxy's routing entirely. A relative server
  // URL (OpenAPI 3 allows this) resolves against the browser's origin regardless of where the
  // Swagger UI page itself is served from, without touching any actual route path. Unset by
  // default so local behavior is unchanged; set SWAGGER_SERVER_PATH=/api only where this API
  // is actually reverse-proxied under that prefix.
  if (process.env.SWAGGER_SERVER_PATH) {
    swaggerConfigBuilder.addServer(process.env.SWAGGER_SERVER_PATH);
  }

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfigBuilder.build());
  SwaggerModule.setup('api', app, swaggerDocument);

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap();
