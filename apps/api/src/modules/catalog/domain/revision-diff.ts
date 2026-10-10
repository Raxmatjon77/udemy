import type { RevisionDiff, RevisionDiffField } from '@udemy/contracts';
import type { SnapshotContent, SnapshotLecture, SnapshotSection } from './revision-snapshot';

/** Header fields in contract order (`REVISION_DIFF_FIELDS`). */
const SCALAR_FIELDS = [
  'title',
  'subtitle',
  'descriptionMd',
  'language',
  'level',
  'categoryId',
  'thumbnailAssetId',
] as const satisfies readonly RevisionDiffField[];
const LIST_FIELDS = ['outcomes', 'requirements'] as const satisfies readonly RevisionDiffField[];

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

interface Placed<T> {
  readonly item: T;
  readonly sectionId: string;
  readonly position: number;
}

function lecturesById(content: SnapshotContent): Map<string, Placed<SnapshotLecture>> {
  const map = new Map<string, Placed<SnapshotLecture>>();
  for (const section of content.sections) {
    section.lectures.forEach((item, position) =>
      map.set(item.id, { item, sectionId: section.id, position }),
    );
  }
  return map;
}

function sectionsById(content: SnapshotContent): Map<string, Placed<SnapshotSection>> {
  return new Map(
    content.sections.map((item, position) => [item.id, { item, sectionId: item.id, position }]),
  );
}

function lectureChanged(a: SnapshotLecture, b: SnapshotLecture): boolean {
  return (
    a.type !== b.type ||
    a.title !== b.title ||
    a.descriptionMd !== b.descriptionMd ||
    a.isPreview !== b.isPreview ||
    a.mediaAssetId !== b.mediaAssetId ||
    a.articleBodyMd !== b.articleBodyMd
  );
}

/**
 * Diff of a revision against a base revision (the one live before it), by stable section and
 * lecture ids (D1: ids survive across revisions). `changed` = content differs; `moved` =
 * position (or, for lectures, section) differs; an id can be both. Removed items are not in
 * the revision, so they carry their titles. Without a base (INITIAL) everything is `added`.
 * All id lists follow the curriculum order of the side they come from.
 */
export function diffRevisions(
  revision: SnapshotContent,
  base: { readonly id: string; readonly content: SnapshotContent } | null,
): RevisionDiff {
  const allSectionIds = revision.sections.map((s) => s.id);
  const allLectureIds = revision.sections.flatMap((s) => s.lectures.map((l) => l.id));
  if (base === null) {
    return {
      baseRevisionId: null,
      changedFields: [],
      sections: { added: allSectionIds, removed: [], changed: [], moved: [] },
      lectures: { added: allLectureIds, removed: [], changed: [], moved: [] },
    };
  }

  const before = base.content;
  const changedFields: RevisionDiffField[] = [];
  for (const field of SCALAR_FIELDS) {
    if (revision[field] !== before[field]) changedFields.push(field);
  }
  for (const field of LIST_FIELDS) {
    if (!sameList(revision[field], before[field])) changedFields.push(field);
  }

  const oldSections = sectionsById(before);
  const newSections = sectionsById(revision);
  const sections: RevisionDiff['sections'] = { added: [], removed: [], changed: [], moved: [] };
  for (const [id, now] of newSections) {
    const then = oldSections.get(id);
    if (then === undefined) {
      sections.added.push(id);
      continue;
    }
    if (now.item.title !== then.item.title || now.item.objective !== then.item.objective) {
      sections.changed.push(id);
    }
    if (now.position !== then.position) sections.moved.push(id);
  }
  for (const [id, then] of oldSections) {
    if (!newSections.has(id)) sections.removed.push({ id, title: then.item.title });
  }

  const oldLectures = lecturesById(before);
  const newLectures = lecturesById(revision);
  const lectures: RevisionDiff['lectures'] = { added: [], removed: [], changed: [], moved: [] };
  for (const [id, now] of newLectures) {
    const then = oldLectures.get(id);
    if (then === undefined) {
      lectures.added.push(id);
      continue;
    }
    if (lectureChanged(now.item, then.item)) lectures.changed.push(id);
    if (now.sectionId !== then.sectionId || now.position !== then.position) {
      lectures.moved.push(id);
    }
  }
  for (const [id, then] of oldLectures) {
    if (!newLectures.has(id)) {
      lectures.removed.push({ id, title: then.item.title, type: then.item.type });
    }
  }

  return { baseRevisionId: base.id, changedFields, sections, lectures };
}
