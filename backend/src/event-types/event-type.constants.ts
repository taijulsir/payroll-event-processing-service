import { BaseEventDto } from './base-event.dto';
import { BankAccountChangeDto } from './bank-account-change.dto';
import { AddressChangeDto } from './address-change.dto';
import { SalaryChangeDto } from './salary-change.dto';

/**
 * Typed as "produces some BaseEventDto" rather than as a union of the three concrete
 * constructors — the caller (validate-event-payload.ts) only needs a class-validator/
 * class-transformer target to instantiate and validate against, not a statically-known
 * subtype; the actual per-type shape is enforced at runtime by whichever class was
 * selected, not by the type system here.
 */
type EventDtoClass = new () => BaseEventDto;

/**
 * The three event types the assignment requires — and, per architecture.md §5/§7 and
 * database-design.md §4/§7, the ONLY place their value set is enforced. `event_type` is
 * stored as plain varchar with no database CHECK constraint specifically so this list can
 * grow (assignment §10 extensibility) without a migration — adding
 * `TAX_CLASS_CHANGE` later means adding one DTO class and one entry here, nothing else in
 * this map's shape.
 */
export const EVENT_TYPE_DTO_MAP: Record<
  'BANK_ACCOUNT_CHANGE' | 'ADDRESS_CHANGE' | 'SALARY_CHANGE',
  EventDtoClass
> = {
  BANK_ACCOUNT_CHANGE: BankAccountChangeDto,
  ADDRESS_CHANGE: AddressChangeDto,
  SALARY_CHANGE: SalaryChangeDto,
};

export type SupportedEventType = keyof typeof EVENT_TYPE_DTO_MAP;

export const SUPPORTED_EVENT_TYPES = Object.keys(EVENT_TYPE_DTO_MAP) as SupportedEventType[];

export function isSupportedEventType(value: unknown): value is SupportedEventType {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(EVENT_TYPE_DTO_MAP, value)
  );
}
