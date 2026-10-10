export const BUILDER_TABS = ['details', 'curriculum', 'review'] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];
