'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';

import {
  addToWishlist,
  engagementKeys,
  fetchWishlistStates,
  removeFromWishlist,
} from '@/lib/engagement/client';
import { problemMessage } from '@/lib/problem';

/**
 * The wishlist heart on the landing page (design D19; signed-in visitors only). Owned or
 * enrolled courses cannot be wishlisted (409 `course_not_wishlistable`): the button explains.
 */
export function WishlistButton({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const key = engagementKeys.wishlistStates([courseId]);
  const state = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchWishlistStates([courseId], signal),
  });
  const wishlisted = state.data?.find((s) => s.courseId === courseId)?.wishlisted ?? false;
  const toggle = useMutation({
    mutationFn: (on: boolean) => (on ? addToWishlist(courseId) : removeFromWishlist(courseId)),
    onSuccess: (_, on) => {
      queryClient.setQueryData(key, [{ courseId, wishlisted: on }]);
      void queryClient.invalidateQueries({ queryKey: engagementKeys.wishlistAll });
    },
  });

  if (state.isPending || state.isError) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-pressed={wishlisted}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!wishlisted)}
        className="text-foreground"
      >
        <svg
          viewBox="0 0 24 24"
          fill={wishlisted ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          className="size-4 text-rose-600"
          aria-hidden="true"
        >
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
        {wishlisted ? 'Wishlisted' : 'Add to wishlist'}
      </Button>
      {toggle.isError ? (
        <p role="alert" className="text-xs">
          {problemMessage(toggle.error, {
            [ErrorCode.CourseNotWishlistable]: 'You already have access to this course.',
            [ErrorCode.WishlistFull]: 'Your wishlist is full. Remove a course first.',
          })}
        </p>
      ) : null}
    </div>
  );
}
