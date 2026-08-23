import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  EVENT_TYPE_DTO_MAP,
  isSupportedEventType,
  SUPPORTED_EVENT_TYPES,
} from './event-type.constants';

export interface ValidatedEvent {
  eventType: string;
  /** Plain object built from the validated DTO instance — safe to store as `payload` jsonb. */
  payload: Record<string, unknown>;
}

function flattenErrors(errors: ValidationError[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    if (error.constraints) {
      messages.push(...Object.values(error.constraints));
    }
    if (error.children?.length) {
      messages.push(...flattenErrors(error.children));
    }
  }
  return messages;
}

/**
 * Validates a raw request body against the DTO for whichever `eventType` it declares.
 *
 * This is deliberately NOT wired through Nest's automatic `@Body()` pipe: the pipe can only
 * validate against one fixed DTO class per route, and which class applies here depends on a
 * runtime field (`eventType`) inside the body itself. This function does the same
 * `whitelist`/`forbidNonWhitelisted` validation the global ValidationPipe applies elsewhere
 * (main.ts), just dispatched to the right per-type class first (architecture.md §5: "one
 * DTO per event type").
 */
export async function validateEventPayload(body: unknown): Promise<ValidatedEvent> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }

  const eventType = (body as Record<string, unknown>).eventType;
  if (!isSupportedEventType(eventType)) {
    throw new BadRequestException(`eventType must be one of: ${SUPPORTED_EVENT_TYPES.join(', ')}`);
  }

  const DtoClass = EVENT_TYPE_DTO_MAP[eventType];
  const instance = plainToInstance(DtoClass, body);

  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });

  if (errors.length > 0) {
    throw new BadRequestException(flattenErrors(errors));
  }

  // Store payload without the redundant `eventType` (it already has its own column) —
  // matches the sample record shape in docs/database-design.md §17.
  const payload = { ...(instance as unknown as Record<string, unknown>) };
  delete payload.eventType;

  return { eventType, payload };
}
