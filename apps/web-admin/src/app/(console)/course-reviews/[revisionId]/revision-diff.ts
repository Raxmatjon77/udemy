import type { RevisionDiff, RevisionDiffField } from '@udemy/contracts';

/** What changed about one section or lecture compared to the live revision. */
export type ItemChange = 'added' | 'changed' | 'moved';

export interface DiffIndex {
  /** False for an INITIAL revision: there is nothing live to compare with. */
  hasBase: boolean;
  fieldChanged: (field: RevisionDiffField) => boolean;
  section: (id: string) => ItemChange[];
  lecture: (id: string) => ItemChange[];
  /** Nothing differs from the live revision except, possibly, removed items. */
  isEmpty: boolean;
}

function marks(
  id: string,
  sets: { added: ReadonlySet<string>; changed: ReadonlySet<string>; moved: ReadonlySet<string> },
): ItemChange[] {
  if (sets.added.has(id)) return ['added'];
  const out: ItemChange[] = [];
  if (sets.changed.has(id)) out.push('changed');
  if (sets.moved.has(id)) out.push('moved');
  return out;
}

/**
 * Lookup helpers over the API's diff (by stable section/lecture ids). For an INITIAL revision
 * every item is "added", which says nothing to a reviewer, so no item gets a mark then.
 */
export function indexDiff(diff: RevisionDiff): DiffIndex {
  const hasBase = diff.baseRevisionId !== null;
  const fields = new Set<RevisionDiffField>(diff.changedFields);
  const sections = {
    added: new Set(diff.sections.added),
    changed: new Set(diff.sections.changed),
    moved: new Set(diff.sections.moved),
  };
  const lectures = {
    added: new Set(diff.lectures.added),
    changed: new Set(diff.lectures.changed),
    moved: new Set(diff.lectures.moved),
  };
  const isEmpty =
    fields.size === 0 &&
    [sections, lectures].every(
      (sets) => sets.added.size === 0 && sets.changed.size === 0 && sets.moved.size === 0,
    ) &&
    diff.sections.removed.length === 0 &&
    diff.lectures.removed.length === 0;

  return {
    hasBase,
    fieldChanged: (field) => hasBase && fields.has(field),
    section: (id) => (hasBase ? marks(id, sections) : []),
    lecture: (id) => (hasBase ? marks(id, lectures) : []),
    isEmpty,
  };
}

export const ITEM_CHANGE_LABEL: Record<ItemChange, string> = {
  added: 'New',
  changed: 'Changed',
  moved: 'Moved',
};
