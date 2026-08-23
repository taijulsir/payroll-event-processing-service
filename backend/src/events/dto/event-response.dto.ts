import { ApiProperty } from '@nestjs/swagger';
import type { PayrollEvent } from '@prisma/client';

export class EventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty() eventType!: string;
  @ApiProperty({
    description:
      'Per-employee submission order. A JSON string, not a number, to avoid 64-bit precision loss.',
  })
  sequence!: string;
  @ApiProperty() idempotencyKey!: string;
  @ApiProperty() payload!: Record<string, unknown>;
  @ApiProperty({ enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] })
  status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiProperty({ nullable: true }) result!: unknown | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty({ nullable: true, enum: ['RETRYABLE', 'PERMANENT', null] })
  failureType!: string | null;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ nullable: true }) processingStartedAt!: string | null;
  @ApiProperty({ nullable: true }) processingFinishedAt!: string | null;
}

/**
 * Maps a Prisma `PayrollEvent` row to the API's public response shape.
 *
 * `sequence` is Postgres `bigint` → JS `bigint`, which `JSON.stringify` cannot serialize at
 * all (it throws). Converting to a decimal string (not `Number`) avoids both that crash and
 * any silent precision loss for values beyond `Number.MAX_SAFE_INTEGER` — the same approach
 * commonly used for other 64-bit IDs exposed over JSON APIs.
 */
export function toEventResponseDto(event: PayrollEvent): EventResponseDto {
  return {
    id: event.id,
    employeeId: event.employeeId,
    eventType: event.eventType,
    sequence: event.sequence.toString(),
    idempotencyKey: event.idempotencyKey,
    payload: event.payload as Record<string, unknown>,
    status: event.status,
    attempts: event.attempts,
    maxAttempts: event.maxAttempts,
    result: event.result,
    failureReason: event.failureReason,
    failureType: event.failureType,
    submittedAt: event.submittedAt.toISOString(),
    processingStartedAt: event.processingStartedAt ? event.processingStartedAt.toISOString() : null,
    processingFinishedAt: event.processingFinishedAt
      ? event.processingFinishedAt.toISOString()
      : null,
  };
}
