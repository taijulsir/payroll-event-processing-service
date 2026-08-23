import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/**
 * GET /events query parameters — architecture.md §6: "List events (filter by
 * employeeId/status, simple pagination)". Deliberately just these four fields: no sort
 * options, no date-range/search filters, no cursor pagination — nothing beyond what's
 * already documented as approved, per this phase's explicit instruction not to invent a
 * bigger filtering/pagination framework.
 */
export class ListEventsQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  // Intentionally a plain string filter, not restricted to the four known status values:
  // status is application-validated on write (database-design.md §7), not on read, and an
  // unmatched filter value here just yields an empty list — harmless, and simpler than
  // adding enum validation for a read-only query parameter.
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
