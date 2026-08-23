import { Equals, IsNotEmpty, IsString } from 'class-validator';
import { BaseEventDto } from './base-event.dto';

export class AddressChangeDto extends BaseEventDto {
  @Equals('ADDRESS_CHANGE')
  eventType!: 'ADDRESS_CHANGE';

  @IsString()
  @IsNotEmpty()
  street!: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsString()
  @IsNotEmpty()
  postalCode!: string;

  @IsString()
  @IsNotEmpty()
  country!: string;
}
