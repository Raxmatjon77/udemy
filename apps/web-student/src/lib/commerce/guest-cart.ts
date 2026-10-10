'use client';

import { CART_LIMITS, UuidSchema } from '@udemy/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import { z } from 'zod';

/**
 * The guest cart (Phase 4 D4): a signed-out visitor's cart lives in `localStorage` as **course
 * ids only**, at most `CART_LIMITS.maxItems`. Nothing about it is trusted: prices come from the
 * public price endpoint and are informational, and after login the ids are merged into the
 * server cart with `POST /me/cart/merge` (best effort: ineligible ids are skipped and reported).
 *
 * Display hints (title, slug) are kept under a separate key, written when a course is added
 * from its landing page, because no public endpoint resolves course ids to titles (see the
 * P4-T9 report). They are labels only and never sent anywhere.
 *
 * Storage can be unavailable (private mode, blocked site data): every access is guarded and the
 * cart then simply behaves as empty.
 */

export const GUEST_CART_KEY = 'udemy.guest-cart.v1';
export const GUEST_CART_LABELS_KEY = 'udemy.guest-cart-labels.v1';

export interface GuestCartLabel {
  title: string;
  slug: string;
}

const IdsSchema = z.array(UuidSchema).max(CART_LIMITS.maxItems);
const LabelsSchema = z.record(
  z.string(),
  z.object({ title: z.string().max(200), slug: z.string().max(200) }),
);

const EMPTY: readonly string[] = Object.freeze([]);

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

let snapshot: { raw: string | null; ids: readonly string[] } = { raw: null, ids: EMPTY };

function parseIds(raw: string | null): readonly string[] {
  if (raw === null) return EMPTY;
  try {
    const parsed = IdsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? Object.freeze([...new Set(parsed.data)]) : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** The current ids; the same array instance until the stored value changes. */
export function readGuestCart(): readonly string[] {
  let raw: string | null;
  try {
    raw = storage()?.getItem(GUEST_CART_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== snapshot.raw) snapshot = { raw, ids: parseIds(raw) };
  return snapshot.ids;
}

function readLabels(): Record<string, GuestCartLabel> {
  try {
    const raw = storage()?.getItem(GUEST_CART_LABELS_KEY);
    if (!raw) return {};
    const parsed = LabelsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function write(ids: readonly string[], labels?: Record<string, GuestCartLabel>): void {
  const store = storage();
  if (!store) return;
  try {
    if (ids.length === 0) {
      store.removeItem(GUEST_CART_KEY);
      store.removeItem(GUEST_CART_LABELS_KEY);
    } else {
      store.setItem(GUEST_CART_KEY, JSON.stringify(ids));
      if (labels) store.setItem(GUEST_CART_LABELS_KEY, JSON.stringify(labels));
    }
  } catch {
    // Quota or blocked storage: the cart stays as it was.
  }
  emit();
}

export type AddToGuestCartResult = 'added' | 'present' | 'full' | 'unavailable';

export function addToGuestCart(courseId: string, label?: GuestCartLabel): AddToGuestCartResult {
  if (!storage()) return 'unavailable';
  const ids = readGuestCart();
  if (ids.includes(courseId)) return 'present';
  if (ids.length >= CART_LIMITS.maxItems) return 'full';
  const labels = readLabels();
  if (label) labels[courseId] = label;
  write([...ids, courseId], labels);
  return 'added';
}

export function removeFromGuestCart(courseId: string): void {
  const labels = readLabels();
  delete labels[courseId];
  write(
    readGuestCart().filter((id) => id !== courseId),
    labels,
  );
}

export function clearGuestCart(): void {
  write(EMPTY);
}

/** The display hint stored for a course, if any. */
export function guestCartLabel(courseId: string): GuestCartLabel | undefined {
  return readLabels()[courseId];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs: the `storage` event fires there when this origin's localStorage changes.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === GUEST_CART_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const serverSnapshot = () => EMPTY;

/** The guest cart's ids, live across components and tabs (empty during SSR and hydration). */
export function useGuestCart() {
  const ids = useSyncExternalStore(subscribe, readGuestCart, serverSnapshot);
  const has = useCallback((courseId: string) => ids.includes(courseId), [ids]);
  return {
    ids,
    has,
    add: addToGuestCart,
    remove: removeFromGuestCart,
    clear: clearGuestCart,
    label: guestCartLabel,
  };
}
