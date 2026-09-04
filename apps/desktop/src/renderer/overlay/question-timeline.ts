export type TimelineItem = { questionId: string; sequence?: number };
/** Updates never move an existing question/group to the tail. Sequence is local
 * first-observed order, unaffected by delayed answer/error/status events. */
export function upsertTimelineGroup<T extends {id: string; items: TimelineItem[]}>(groups: T[], incoming: T): T[] {
  const previous = new Map(groups.flatMap(group => group.items).map(item => [item.questionId, item.sequence]));
  let sequence = Math.max(0, ...[...previous.values()].map(value => value ?? 0));
  const next = { ...incoming, items: incoming.items.map(item => ({...item, sequence: previous.get(item.questionId) ?? ++sequence})) };
  return groups.some(group => group.id === next.id) ? groups.map(group => group.id === next.id ? next : group) : [...groups, next];
}
