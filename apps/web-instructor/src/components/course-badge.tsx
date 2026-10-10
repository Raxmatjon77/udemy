import type { CourseBadge as CourseBadgeValue } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';

import { COURSE_BADGE_LABELS, COURSE_BADGE_VARIANTS } from '@/lib/labels';

export function CourseBadge({ badge }: { badge: CourseBadgeValue }) {
  return <Badge variant={COURSE_BADGE_VARIANTS[badge]}>{COURSE_BADGE_LABELS[badge]}</Badge>;
}
