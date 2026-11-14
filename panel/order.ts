export type SortMode = 'manual' | 'attention' | 'name';

export interface OrderItem {
  id: string;
  title: string;
  state: string;
}

export function parseOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set((value as unknown[]).filter((item: unknown): item is string =>
    typeof item === 'string' && /^pokemon\.v1:[0-9a-f]{64}$/.test(item)))];
}

export function reconcileOrder(order: string[], ids: string[]): string[] {
  return [...new Set([...order, ...ids])];
}

export function moveOrder(order: string[], source: string, target: string, after: boolean): string[] {
  const result: string[] = [...order];
  if (source === target || !result.includes(source) || !result.includes(target)) return result;
  result.splice(result.indexOf(source), 1);
  result.splice(result.indexOf(target) + (after ? 1 : 0), 0, source);
  return result;
}

export function orderedIds(rows: OrderItem[], manual: string[], mode: SortMode): string[] {
  const byId: Map<string, OrderItem> = new Map(rows.map((row: OrderItem): [string, OrderItem] => [row.id, row]));
  const ids: string[] = reconcileOrder(manual, rows.map((row: OrderItem): string => row.id))
    .filter((id: string): boolean => byId.has(id));
  if (mode === 'manual') return ids;
  return ids.sort((left: string, right: string): number => {
    const a: OrderItem = byId.get(left)!;
    const b: OrderItem = byId.get(right)!;
    return mode === 'attention'
      ? Number(b.state === 'blocked') - Number(a.state === 'blocked')
      : a.title.localeCompare(b.title);
  });
}
