import { describe, expect, test } from 'bun:test';
import { ExactDecimalType } from '../../../src/persistence/mikro-orm/types/exact-decimal.type.js';

describe('ExactDecimalType', () => {
  test('does not collapse cent changes above Number.MAX_SAFE_INTEGER', () => {
    const type = new ExactDecimalType();

    expect(type.compareValues('9007199254740993.37', '9007199254740993.36')).toBe(false);
    expect(type.compareValues('9007199254740993.370', '9007199254740993.37')).toBe(true);
  });
});
