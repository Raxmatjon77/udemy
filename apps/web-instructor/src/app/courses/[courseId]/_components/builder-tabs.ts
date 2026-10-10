export const BUILDER_TABS = ['details', 'curriculum', 'pricing', 'promotions', 'review'] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];
