import { describe, expect, test } from 'bun:test';
import { canonicalizeJson, type JsonValue } from '../../../../src/wagering/application/canonical-json.js';
import { Money } from '../../../../src/shared/domain/value-objects/money.js';

describe('canonical JSON', () => {
  test('orders keys recursively independently of insertion order', () => {
    const left = { z: { b: true, a: null }, a: [{ y: '2', x: '1' }, false] };
    const right = { a: [{ x: '1', y: '2' }, false], z: { a: null, b: true } };
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(canonicalizeJson(left)).toBe('{"a":[{"x":"1","y":"2"},false],"z":{"a":null,"b":true}}');
  });

  test('sorts numeric-looking keys lexicographically and preserves escaped Unicode strings', () => {
    expect(canonicalizeJson({ '2': 'ação\n"', '10': '\\' })).toBe('{"10":"\\\\","2":"ação\\n\\\""}');
  });

  test('omits optional undefined object properties while preserving null', () => {
    expect(canonicalizeJson({ optional: undefined, nested: { absent: undefined }, value: null }))
      .toBe('{"nested":{},"value":null}');
  });

  test('preserves array order, scalars, and Money public decimal strings', () => {
    expect(canonicalizeJson(['25.00', 25, true, false, null])).toBe('["25.00",25,true,false,null]');
    expect(canonicalizeJson({ money: { ...Money.from({ amount: '25.00', currency: 'BRL' }).toJSON() } }))
      .toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
    expect(canonicalizeJson(['a', 'b'])).not.toBe(canonicalizeJson(['b', 'a']));
  });

  test.each([undefined, [undefined], new Array(1), NaN, Infinity, new Date(), 1n, () => {}])(
    'rejects non-JSON runtime values instead of silently hashing a different value: %p', (value) => {
      expect(() => canonicalizeJson(value as JsonValue)).toThrow(TypeError);
    },
  );
});
