import {
  COURSE_LANGUAGE_LABELS,
  COURSE_LEVEL_LABELS,
  type AssetView,
  type RevisionDiffValue,
  type RevisionFieldChange,
  type RevisionSnapshot,
} from '@udemy/contracts';
import { MarkdownView } from '@udemy/markdown/react';

import { REVISION_DIFF_FIELD_LABEL } from '@/lib/labels';

/** Markdown longer than this is shown in a scroll box; the full text is still rendered. */
const MARKDOWN_BOX_THRESHOLD = 400;

function isKey<T extends string>(record: Readonly<Record<T, string>>, key: string): key is T {
  return Object.hasOwn(record, key);
}

function None() {
  return <span className="text-muted-foreground italic">None</span>;
}

/**
 * One side of a changed field. Values are the API's raw diff values: text, enum codes and ids
 * as strings, bullet lists as string arrays, null when unset.
 */
function DiffValue({
  change,
  value,
  side,
  revision,
  assets,
}: {
  change: RevisionFieldChange;
  value: RevisionDiffValue;
  side: 'before' | 'after';
  revision: RevisionSnapshot;
  assets: ReadonlyMap<string, AssetView>;
}) {
  if (value === null) return <None />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <None />;
    return (
      <ul className="grid list-disc gap-0.5 pl-5">
        {value.map((item, i) => (
          <li key={`${i}-${item}`}>{item}</li>
        ))}
      </ul>
    );
  }
  switch (change.field) {
    case 'descriptionMd':
      return (
        <div
          className={
            value.length > MARKDOWN_BOX_THRESHOLD
              ? 'max-h-48 overflow-y-auto rounded-md border bg-background p-3'
              : 'rounded-md border bg-background p-3'
          }
        >
          <MarkdownView source={value} idPrefix={`diff-${side}-description-`} className="text-sm" />
        </div>
      );
    case 'language':
      return <>{isKey(COURSE_LANGUAGE_LABELS, value) ? COURSE_LANGUAGE_LABELS[value] : value}</>;
    case 'level':
      return <>{isKey(COURSE_LEVEL_LABELS, value) ? COURSE_LEVEL_LABELS[value] : value}</>;
    case 'categoryId': {
      const category = revision.category;
      if (category?.id === value) {
        return (
          <>
            {category.parent ? `${category.parent.name} › ` : ''}
            {category.name}
          </>
        );
      }
      return (
        <span>
          A different category <code className="text-xs break-all">{value}</code>
        </span>
      );
    }
    case 'thumbnailAssetId': {
      const asset = assets.get(value);
      return asset ? (
        <>{asset.originalFilename}</>
      ) : (
        <span>
          {side === 'before' ? 'The previous image' : 'An image'}{' '}
          <code className="text-xs break-all">{value}</code>
        </span>
      );
    }
    default:
      return <span className="break-words whitespace-pre-line">{value}</span>;
  }
}

/** Before (live) and after (submitted) values of each changed header field. */
export function FieldChanges({
  changes,
  revision,
  assets,
}: {
  changes: readonly RevisionFieldChange[];
  revision: RevisionSnapshot;
  assets: ReadonlyMap<string, AssetView>;
}) {
  return (
    <ul className="grid gap-4" aria-label="Changed details">
      {changes.map((change) => (
        <li key={change.field} data-field-change={change.field} className="grid gap-2">
          <h4 className="font-medium">{REVISION_DIFF_FIELD_LABEL[change.field]}</h4>
          <dl className="grid gap-2">
            <div className="grid gap-1" data-side="before">
              <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Before
              </dt>
              <dd className="text-muted-foreground">
                <DiffValue
                  change={change}
                  value={change.before}
                  side="before"
                  revision={revision}
                  assets={assets}
                />
              </dd>
            </div>
            <div className="grid gap-1" data-side="after">
              <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                After
              </dt>
              <dd className="text-foreground">
                <DiffValue
                  change={change}
                  value={change.after}
                  side="after"
                  revision={revision}
                  assets={assets}
                />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
