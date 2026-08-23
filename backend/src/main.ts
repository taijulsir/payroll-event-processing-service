import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.enableCors();
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
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payroll Event Processing Service')
    .setDescription('API for submitting and tracking payroll events')
    .setVersion('0.1.0')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, swaggerDocument);

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap();
