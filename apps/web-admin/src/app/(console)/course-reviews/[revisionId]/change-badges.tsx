import { Badge } from '@udemy/ui/components/badge';

import { ITEM_CHANGE_LABEL, type ItemChange } from './revision-diff';

const VARIANT: Record<ItemChange, 'default' | 'secondary' | 'outline'> = {
  added: 'default',
  changed: 'secondary',
  moved: 'outline',
};

/** "New" / "Changed" / "Moved" marks against the live revision. */
export function ChangeBadges({ changes }: { changes: readonly ItemChange[] }) {
  if (changes.length === 0) return null;
  return (
    <>
      {changes.map((change) => (
        <Badge key={change} variant={VARIANT[change]} data-change={change}>
          {ITEM_CHANGE_LABEL[change]}
        </Badge>
      ))}
    </>
  );
}
