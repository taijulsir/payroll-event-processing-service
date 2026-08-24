import { ApiProperty } from '@nestjs/swagger';
import type { EventStatusHistory } from '@prisma/client';

export class EventStatusHistoryEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) fromStatus!: string | null;
  @ApiProperty() toStatus!: string;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ nullable: true }) attemptNumber!: number | null;
  @ApiProperty({ nullable: true }) errorMessage!: string | null;
}

export function toEventStatusHistoryEntryDto(
  entry: EventStatusHistory,
): EventStatusHistoryEntryDto {
  return {
    id: entry.id,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    occurredAt: entry.occurredAt.toISOString(),
    attemptNumber: entry.attemptNumber,
    errorMessage: entry.errorMessage,
  };
}
