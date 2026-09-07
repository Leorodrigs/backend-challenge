import { DecimalType } from '@mikro-orm/core';
import { Decimal } from 'decimal.js';

const ComparisonDecimal = Decimal.clone({ precision: 40 });

/**
 * Keeps MikroORM dirty checking exact for NUMERIC values represented as strings.
 * The built-in DecimalType compares through a JavaScript number, which makes
 * cent-level changes above Number.MAX_SAFE_INTEGER indistinguishable.
 */
export class ExactDecimalType extends DecimalType<'string'> {
  constructor() {
    super('string');
  }

  override compareValues(a: string, b: string): boolean {
    return new ComparisonDecimal(a).equals(new ComparisonDecimal(b));
  }
}
