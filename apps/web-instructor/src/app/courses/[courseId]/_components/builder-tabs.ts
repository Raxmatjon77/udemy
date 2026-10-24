export const BUILDER_TABS = [
  'details',
  'curriculum',
  'pricing',
  'promotions',
  'review',
  'reviews',
  'announcements',
] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];
