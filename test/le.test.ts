import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstMessage, le } from '../src/outreach.ts';

test('le: "ל" joined to a Hebrew name, "ל־" before any other, "בשביל" before one that opens with ה', () => {
  assert.equal(le('כלי חרס של נורית'), 'לכלי חרס של נורית');
  assert.equal(le('Nike'), 'ל־Nike');
  // The ה may be the article or the name's own letter; "בשביל" reads right either way, never "להחנות".
  assert.equal(le('החנות של דנה'), 'בשביל החנות של דנה');
  assert.equal(le('הדס'), 'בשביל הדס');
  assert.doesNotMatch(firstMessage({ storeName: 'החנות של דנה', url: 'https://x.test/s/a' }), /להחנות/);
});
