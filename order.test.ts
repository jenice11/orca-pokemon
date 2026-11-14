import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, reconcileOrder, moveOrder, orderedIds, type OrderItem } from './panel/order.ts';
import { choiceKey } from './model.ts';

test('parseOrder accepts actual choice keys and filters malformed members and duplicates', async (): Promise<void> => {
  const key: string = await choiceKey('agent');
  const second: string = `pokemon.v1:${'b'.repeat(64)}`;
  const input: unknown[] = [key, null, 1, {}, key, second, `species.v1.${'a'.repeat(64)}`,
    `pokemon.v1:${'A'.repeat(64)}`, `pokemon.v1:${'a'.repeat(63)}`, `${key}\n`, ''];
  const before: unknown[] = [...input];
  assert.deepEqual(parseOrder(input), [key, second]);
  assert.deepEqual(input, before);
  for (const value of [null, undefined, {}, key, 1]) assert.deepEqual(parseOrder(value), []);
});

test('reconcileOrder deduplicates discovery and retains removed agents for reappearance', (): void => {
  const manual: string[] = ['b', 'a', 'b'];
  const ids: string[] = ['c', 'a', 'c'];
  const reconciled: string[] = reconcileOrder(manual, ids);
  assert.deepEqual(reconciled, ['b', 'a', 'c']);
  assert.deepEqual(reconcileOrder(reconciled, ['c']), ['b', 'a', 'c']);
  assert.deepEqual(reconcileOrder(reconciled, ['c', 'b', 'd']), ['b', 'a', 'c', 'd']);
  assert.deepEqual(manual, ['b', 'a', 'b']);
  assert.deepEqual(ids, ['c', 'a', 'c']);
  assert.deepEqual(reconcileOrder([], []), []);
});

test('moveOrder handles both directions, boundaries, adjacent moves and no-ops without mutation', (): void => {
  const order: string[] = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveOrder(order, 'a', 'd', true), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveOrder(order, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveOrder(order, 'a', 'c', false), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveOrder(order, 'd', 'b', true), ['a', 'b', 'd', 'c']);
  assert.deepEqual(moveOrder(order, 'b', 'c', true), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveOrder(order, 'c', 'b', false), ['a', 'c', 'b', 'd']);
  for (const [source, target] of [['a', 'a'], ['missing', 'a'], ['a', 'missing'], ['b', 'c']]) {
    assert.deepEqual(moveOrder(order, source, target, false), order);
  }
  assert.deepEqual(moveOrder([], 'a', 'b', true), []);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('orderedIds uses manual history, new discovery order, stable attention groups and name ties', (): void => {
  const rows: OrderItem[] = [
    { id: 'a', title: 'Same', state: 'working' },
    { id: 'b', title: 'Zulu', state: 'blocked' },
    { id: 'c', title: 'Same', state: 'blocked' },
    { id: 'd', title: 'Alpha', state: 'waiting' },
    { id: 'e', title: 'Same', state: 'unknown' }
  ];
  const manual: string[] = ['gone', 'c', 'a', 'c'];
  const before: OrderItem[] = structuredClone(rows);
  assert.deepEqual(orderedIds(rows, manual, 'manual'), ['c', 'a', 'b', 'd', 'e']);
  assert.deepEqual(orderedIds(rows, manual, 'attention'), ['c', 'b', 'a', 'd', 'e']);
  assert.deepEqual(orderedIds(rows, manual, 'name'), ['d', 'c', 'a', 'e', 'b']);
  assert.deepEqual(orderedIds(rows.filter((row: OrderItem): boolean => row.id !== 'c'), manual, 'manual'), ['a', 'b', 'd', 'e']);
  assert.deepEqual(orderedIds(rows, manual, 'manual'), ['c', 'a', 'b', 'd', 'e']);
  assert.deepEqual(orderedIds([], manual, 'name'), []);
  assert.deepEqual(rows, before);
  assert.deepEqual(manual, ['gone', 'c', 'a', 'c']);
});
