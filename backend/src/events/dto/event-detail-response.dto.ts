import { ApiProperty } from '@nestjs/swagger';
import type { EventStatusHistory, PayrollEvent } from '@prisma/client';
import { EventResponseDto, toEventResponseDto } from './event-response.dto';
import {
  EventStatusHistoryEntryDto,
  toEventStatusHistoryEntryDto,
} from './event-status-history.dto';

/**
 * GET /events/:id's response shape — architecture.md §6: "Return type, payload, current
 * status, attempts, result/failure detail, status history." Extends EventResponseDto
 * (reused as-is, including its BigInt-safe `sequence` handling — architecture.md §6/§10's
 * sequence/idempotency information) rather than re-declaring its fields, so POST /events
 * and both GET endpoints stay serialized identically wherever they share fields.
 */
export class EventDetailResponseDto extends EventResponseDto {
  @ApiProperty({ type: [EventStatusHistoryEntryDto] })
  statusHistory!: EventStatusHistoryEntryDto[];
}

export function toEventDetailResponseDto(
  event: PayrollEvent,
  history: EventStatusHistory[],
): EventDetailResponseDto {
  return {
    ...toEventResponseDto(event),
    statusHistory: history.map(toEventStatusHistoryEntryDto),
  };
}
