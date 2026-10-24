/** @vitest-environment jsdom */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FIXTURE_IDS,
  LEARNING_FIXTURE_IDS,
  type LearningMockStore,
} from '@udemy/contracts/testing';
import type { HlsPlayerHandle, PlayedRangesReport } from '@udemy/ui/components/hls-player';
import { http, HttpResponse } from 'msw';
import { useImperativeHandle, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { advanceClock, asViewer, mockLearning } from '@/test/learning';
import { PROXY, setupMswServer } from '@/test/msw';
import { renderWithQuery } from '@/test/render';

import { CoursePlayer } from './course-player';

const { course } = FIXTURE_IDS;
const L = LEARNING_FIXTURE_IDS;

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: router.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

/** jsdom cannot play HLS; the real player is covered in @udemy/ui. This one records its props. */
const player = vi.hoisted(() => ({
  props: null as null | {
    src: string;
    startPosition?: number;
    onPlayedRanges?: (report: PlayedRangesReport) => void;
    onPlayingChange?: (playing: boolean) => void;
  },
  pendingFlush: [] as { from: number; to: number }[],
  position: 0,
  seek: vi.fn(),
}));
vi.mock('@udemy/ui/components/hls-player', () => ({
  HlsPlayer: function FakePlayer(props: {
    src: string;
    title: string;
    startPosition?: number;
    ref?: Ref<HlsPlayerHandle>;
    onPlayedRanges?: (report: PlayedRangesReport) => void;
    onPlayingChange?: (playing: boolean) => void;
  }) {
    player.props = props;
    useImperativeHandle(props.ref, () => ({
      seek: player.seek,
      currentTime: () => player.position,
      isPlaying: () => false,
      flushPlayedRanges: () => {
        const ranges = player.pendingFlush;
        player.pendingFlush = [];
        return { reason: 'flush', positionSeconds: player.position, durationSeconds: 300, ranges };
      },
    }));
    return (
      <div data-testid="hls-player" data-src={props.src} data-start={props.startPosition ?? ''}>
        {props.title}
      </div>
    );
  },
}));

const assigned = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('@/lib/commerce/navigation', () => ({
  assignLocation: (url: string) => assigned.urls.push(url),
}));

/** A controllable IntersectionObserver (jsdom has none). */
const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];
class FakeIntersectionObserver {
  readonly targets: Element[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function scrollIntoView(target: Element) {
  for (const observer of observers) {
    if (observer.targets.includes(target)) {
      observer.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    }
  }
}

const server = setupMswServer();

beforeEach(() => {
  player.props = null;
  player.pendingFlush = [];
  player.position = 0;
  player.seek.mockReset();
  router.push.mockReset();
  assigned.urls = [];
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  server.use(
    http.get(`${PROXY}/catalog/courses/:courseId/lectures/:lectureId/article`, () =>
      HttpResponse.json({ bodyMd: '# Setup\n\nInstall **Node 22**.' }),
    ),
    http.get(`${PROXY}/catalog/courses/:courseId/lectures/:lectureId/download`, () =>
      HttpResponse.json({
        url: 'https://media.test/cheat-sheet.pdf?X-Amz-Signature=x',
        expiresAt: '2026-10-15T12:15:00.000Z',
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The default student, enrolled in "Complete TypeScript". */
function enrolled(seed: Parameters<typeof mockLearning>[1] = {}): LearningMockStore {
  const store = mockLearning(server, seed);
  store.commerce.seedEnrollment(FIXTURE_IDS.student, course);
  return store;
}

function sidebarRow(title: string) {
  const nav = screen.getByRole('navigation', { name: 'Course content' });
  return within(nav).getByRole('link', { name: new RegExp(title) });
}

const coverageOf = (store: LearningMockStore) =>
  store.playerBootstrap(course).sections[0]!.lectures[0]!;

describe('<CoursePlayer> layout', () => {
  it('shows the curriculum with progress and opens the resume lecture', async () => {
    const store = enrolled();
    store.seedCompletion(FIXTURE_IDS.student, course, [L.lectureArticle]);
    renderWithQuery(<CoursePlayer courseId={course} lectureId={null} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy();
    expect(screen.getByTestId('course-progress').textContent).toBe('1 of 4 complete · 25%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    const rows = screen.getAllByTestId('curriculum-lecture');
    expect(rows.map((row) => row.getAttribute('href'))).toEqual(
      [L.lectureVideo, L.lectureArticle, L.lectureResource, L.lectureQuiz].map(
        (id) => `/learn/${course}/${id}`,
      ),
    );
    expect(sidebarRow('Welcome').getAttribute('aria-current')).toBe('page');
    expect(sidebarRow('Setup notes').textContent).toContain('Completed:');
    expect(sidebarRow('Check yourself').textContent).toContain('Quiz · 3 questions');
    expect(screen.getByTestId('hls-player').getAttribute('data-src')).toBe(
      `/api/proxy/catalog/courses/${course}/lectures/${L.lectureVideo}/hls/master.m3u8`,
    );
  });

  it('resumes the video at the saved position, or at ?t= from a note link', async () => {
    const store = enrolled();
    store.recordHeartbeat(course, L.lectureVideo, { positionSeconds: 42, ranges: [] });
    const { unmount } = renderWithQuery(<CoursePlayer courseId={course} lectureId={null} />);
    await screen.findByTestId('hls-player');
    expect(player.props?.startPosition).toBe(42);
    unmount();

    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} startAt={120} />);
    await screen.findByTestId('hls-player');
    expect(player.props?.startPosition).toBe(120);
  });

  it('explains a missing enrollment', async () => {
    mockLearning(server);
    renderWithQuery(<CoursePlayer courseId={course} lectureId={null} />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You are not enrolled in this course',
    );
  });

  it('PREVIEW mode (the owner): content shows, nothing is written', async () => {
    const store = mockLearning(server, { commerceSeed: { viewerId: FIXTURE_IDS.instructor } });
    const puts: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method !== 'GET') puts.push(new URL(request.url).pathname);
    });
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    expect(await screen.findByText(/Preview mode: you own this course/)).toBeTruthy();
    expect(screen.getByTestId('video-status').textContent).toContain('not saved');
    player.props!.onPlayedRanges!({
      reason: 'pause',
      positionSeconds: 30,
      durationSeconds: 300,
      ranges: [{ from: 0, to: 30 }],
    });
    expect(screen.getByRole('button', { name: 'Leave a rating' })).toHaveProperty('disabled', true);
    expect(puts).toEqual([]);
    expect(store.playerBootstrap(course).mode).toBe('PREVIEW');
    server.events.removeAllListeners();
  });
});

describe('video heartbeats', () => {
  it('sends played ranges on pause and completes the lecture at 90% (server-measured)', async () => {
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');

    player.props!.onPlayedRanges!({
      reason: 'pause',
      positionSeconds: 60.4,
      durationSeconds: 300,
      ranges: [{ from: 0.2, to: 59.7 }],
    });
    await waitFor(() => expect(coverageOf(store).coveragePct).toBe(20));
    expect(coverageOf(store).positionSeconds).toBe(60);
    expect(coverageOf(store).completed).toBe(false);

    // 100 s later (the plausibility budget is wall-clock based: 100 × 2.5 + 10 s).
    advanceClock(100_000);
    player.props!.onPlayedRanges!({
      reason: 'seek',
      positionSeconds: 280,
      durationSeconds: 300,
      ranges: [{ from: 60, to: 280 }],
    });
    await waitFor(() => expect(sidebarRow('Welcome').textContent).toContain('Completed:'));
    expect(coverageOf(store).completed).toBe(true);
    expect(screen.getByTestId('course-progress').textContent).toBe('1 of 4 complete · 25%');
  });

  it('seeking alone never counts as watched', async () => {
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    player.props!.onPlayedRanges!({
      reason: 'seek',
      positionSeconds: 295,
      durationSeconds: 300,
      ranges: [],
    });
    await waitFor(() => expect(coverageOf(store).positionSeconds).toBe(295));
    expect(coverageOf(store).coveragePct).toBe(0);
    expect(coverageOf(store).completed).toBe(false);
  });

  it('flushes with keepalive when the page is left', async () => {
    const store = enrolled();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');

    player.position = 30;
    player.pendingFlush = [{ from: 0, to: 30 }];
    window.dispatchEvent(new Event('pagehide'));

    await waitFor(() => expect(coverageOf(store).coveragePct).toBe(10));
    const progressCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/progress'));
    expect(progressCall?.[1]).toMatchObject({ method: 'PUT', keepalive: true });
    expect(JSON.parse(String(progressCall?.[1]?.body))).toEqual({
      positionSeconds: 30,
      ranges: [{ from: 0, to: 30 }],
    });
    fetchSpy.mockRestore();
  });
});

describe('heartbeat cadence', () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('beats every 15 s while playing, flushes on tab hide and pauses while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = enrolled();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const beats = () =>
      fetchSpy.mock.calls
        .filter(([url]) => String(url).endsWith('/progress'))
        .map(([, init]) => init);
    // waitFor polls with setInterval, which is faked here: await the PUT itself instead.
    const lastBeatDone = async () => {
      const index = fetchSpy.mock.calls.findLastIndex(([url]) => String(url).endsWith('/progress'));
      await fetchSpy.mock.results[index]!.value;
    };
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    act(() => player.props!.onPlayingChange!(true));

    player.position = 15;
    player.pendingFlush = [{ from: 0, to: 15 }];
    act(() => vi.advanceTimersByTime(15_000));
    expect(beats()).toHaveLength(1);
    await lastBeatDone();
    expect(coverageOf(store).coveragePct).toBe(5);
    expect(beats()[0]).toMatchObject({ method: 'PUT' });
    expect(beats()[0]).not.toHaveProperty('keepalive');

    // The tab is hidden: one keepalive beat, then the interval stays quiet.
    advanceClock(20_000);
    player.position = 30;
    player.pendingFlush = [{ from: 15, to: 30 }];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(beats()[1]).toMatchObject({ keepalive: true });
    await lastBeatDone();
    expect(coverageOf(store).coveragePct).toBe(10);
    player.pendingFlush = [{ from: 30, to: 45 }];
    act(() => vi.advanceTimersByTime(45_000));
    expect(beats()).toHaveLength(2);

    // Paused: no interval at all.
    act(() => player.props!.onPlayingChange!(false));
    Reflect.deleteProperty(document, 'visibilityState');
    act(() => vi.advanceTimersByTime(60_000));
    expect(beats()).toHaveLength(2);
    fetchSpy.mockRestore();
  });
});

describe('articles and resources', () => {
  it('an article completes when its end scrolls into view (ARTICLE_READ)', async () => {
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureArticle} />);
    const body = await screen.findByTestId('article-body');
    expect(within(body).getByText('Node 22').tagName).toBe('STRONG');

    scrollIntoView(screen.getByTestId('article-end'));
    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Mark as complete' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(store.playerBootstrap(course).progress.completed).toBe(1);
    expect(sidebarRow('Setup notes').textContent).toContain('Completed:');
  });

  it('the manual tick works for articles and can be undone', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureArticle} />);
    const tick = await screen.findByRole('checkbox', { name: 'Mark as complete' });
    await user.click(tick);
    await waitFor(() => expect(tick.getAttribute('aria-checked')).toBe('true'));
    expect(store.playerBootstrap(course).progress.pct).toBe(25);
    await user.click(tick);
    await waitFor(() => expect(tick.getAttribute('aria-checked')).toBe('false'));
    expect(store.playerBootstrap(course).progress.pct).toBe(0);
  });

  it('a resource download marks it opened (RESOURCE_OPENED)', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureResource} />);
    await user.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(assigned.urls).toEqual([expect.stringContaining('cheat-sheet.pdf')]),
    );
    await waitFor(() => expect(sidebarRow('Cheat sheet').textContent).toContain('Completed:'));
    expect(store.playerBootstrap(course).progress.completed).toBe(1);
  });

  it('videos and quizzes have no manual tick', async () => {
    enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    expect(screen.queryByRole('checkbox', { name: 'Mark as complete' })).toBeNull();
    expect(screen.getByTestId('video-status').textContent).toContain('90%');
  });
});

describe('<QuizRunner>', () => {
  async function answer(
    user: ReturnType<typeof userEvent.setup>,
    picks: [string[], string[], string[]],
  ) {
    for (const [index, labels] of picks.entries()) {
      for (const label of labels)
        await user.click(
          await screen.findByRole(index === 1 ? 'checkbox' : 'radio', { name: label }),
        );
      await user.click(screen.getByRole('button', { name: index === 2 ? 'Submit quiz' : 'Next' }));
    }
  }

  it('shows only right/wrong before passing, and the key and explanations after a pass', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureQuiz} />);
    expect(await screen.findByText('3 questions · pass with 70% or more')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Start quiz' }));
    expect((await screen.findByTestId('quiz-position')).textContent).toBe('Question 1 of 3');
    // Nothing on screen hints at the answer before a submit.
    expect(document.body.textContent).not.toMatch(/correct/i);

    // Q1 right, Q2 wrong, Q3 wrong: 33% < 70%.
    await answer(user, [['B. const'], ['B. object'], ['A. True']]);
    const failed = await screen.findByRole('region', { name: 'Quiz result' });
    expect(within(failed).getByRole('heading').textContent).toBe('Not passed yet');
    expect(within(failed).getByTestId('quiz-score').textContent).toContain('You scored 33%');
    expect(
      within(failed)
        .getAllByTestId('quiz-result-question')
        .map((q) => q.querySelector('p')!.textContent),
    ).toEqual([
      'Question 1: Your answer is correct',
      'Question 2: Your answer is incorrect',
      'Question 3: Your answer is incorrect',
    ]);
    expect(within(failed).queryByTestId('quiz-correct-options')).toBeNull();
    expect(within(failed).queryByTestId('quiz-explanation')).toBeNull();
    expect(within(failed).getByText(/shown once you pass/)).toBeTruthy();
    expect(sidebarRow('Check yourself').textContent).toContain('Not completed:');

    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    await answer(user, [['B. const'], ['A. string', 'C. boolean'], ['B. False']]);
    const passed = await screen.findByRole('region', { name: 'Quiz result' });
    expect(within(passed).getByRole('heading').textContent).toBe('You passed!');
    expect(
      within(passed)
        .getAllByTestId('quiz-correct-options')
        .map((p) => p.textContent),
    ).toEqual([
      'Correct answer: B. const',
      'Correct answer: A. string; C. boolean',
      'Correct answer: B. False',
    ]);
    expect(within(passed).getAllByTestId('quiz-explanation')).toHaveLength(2);
    await waitFor(() => expect(sidebarRow('Check yourself').textContent).toContain('Completed:'));
    expect(store.playerBootstrap(course).progress.completed).toBe(1);
  });
});

describe('notes', () => {
  it('saves a note at the current video position and seeks back to it', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    player.position = 83.6;
    await user.type(
      screen.getByRole('textbox', { name: 'New note at the current position' }),
      'Generics are **erased**',
    );
    await user.click(screen.getByRole('button', { name: 'Save note' }));
    const note = await screen.findByTestId('note');
    expect(within(note).getByText('erased').tagName).toBe('STRONG');
    expect(store.listNotes(course)).toEqual([
      expect.objectContaining({ lectureId: L.lectureVideo, positionSeconds: 83 }),
    ]);

    await user.click(within(note).getByRole('button', { name: 'Go to 1:23' }));
    expect(player.seek).toHaveBeenCalledWith(83);
  });

  it('a note on another lecture opens that lecture at the timestamp', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    store.createNote(course, { lectureId: L.lectureVideo, positionSeconds: 15, bodyMd: 'Intro' });
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureArticle} />);
    await screen.findByTestId('article-body');
    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    await user.click(screen.getByRole('button', { name: 'All lectures' }));
    await user.click(await screen.findByRole('button', { name: 'Go to 0:15' }));
    expect(router.push).toHaveBeenCalledWith(`/learn/${course}/${L.lectureVideo}?t=15`);
  });
});

describe('Q&A', () => {
  it('asks a question, shows the instructor answer with its badge, votes and reports', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    // Q&A is the default tab.
    expect(await screen.findByText('No questions yet. Be the first to ask!')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Ask a question' }));
    const form = screen.getByRole('form', { name: 'Ask a question' });
    await user.type(within(form).getByRole('textbox', { name: 'Title' }), 'Why is const mutable?');
    await user.type(within(form).getByRole('textbox', { name: 'Details (Markdown)' }), 'Arrays?');
    await user.click(within(form).getByRole('button', { name: 'Post question' }));

    const thread = await screen.findByRole('article', { name: 'Why is const mutable?' });
    const [question] = store.listQuestions(course, { sort: 'recent' });
    expect(question).toMatchObject({ lectureId: L.lectureVideo, mine: true });

    asViewer(store, { userId: FIXTURE_IDS.instructor, app: 'instructor' }, () =>
      store.postAnswer(course, question!.id, 'It freezes the **binding**.'),
    );
    await user.click(within(thread).getByRole('button', { name: '← All questions' }));
    await user.click(await screen.findByRole('button', { name: 'Why is const mutable?' }));

    const answer = await screen.findByTestId('answer');
    expect(within(answer).getByTestId('instructor-badge').textContent).toBe('Instructor');
    expect(within(answer).getByText('binding').tagName).toBe('STRONG');

    // My own question cannot be up-voted by me; the answer can.
    expect(screen.getByRole('button', { name: 'Upvote question (0)' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(answer).getByRole('button', { name: 'Upvote answer (0)' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('answer'))
          .getByRole('button', { name: 'Upvote answer (1)' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );

    await user.click(
      within(screen.getByTestId('answer')).getByRole('button', { name: 'Accept answer' }),
    );
    await waitFor(() =>
      expect(within(screen.getByTestId('answer')).getByText('Accepted answer')).toBeTruthy(),
    );

    await user.click(
      within(screen.getByTestId('answer')).getByRole('button', { name: 'Report this answer' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Report this answer' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Reason' }), 'OFF_TOPIC');
    await user.click(within(dialog).getByRole('button', { name: 'Send report' }));
    expect((await within(dialog).findByRole('status')).textContent).toContain(
      'received your report',
    );
  });
});

describe('announcements', () => {
  it('lists the course announcements with markdown bodies', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    asViewer(store, { userId: FIXTURE_IDS.instructor, app: 'instructor' }, () =>
      store.postAnnouncement(course, {
        title: 'New section on generics',
        bodyMd: 'Five **new** lectures.',
        sendEmail: false,
      }),
    );
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    await screen.findByTestId('hls-player');
    await user.click(screen.getByRole('tab', { name: 'Announcements' }));
    const item = await screen.findByTestId('announcement');
    expect(within(item).getByRole('heading').textContent).toBe('New section on generics');
    expect(within(item).getByText('new').tagName).toBe('STRONG');
  });
});

describe('rating dialog', () => {
  it('is blocked until a lecture is completed (blockReason), then saves a review', async () => {
    const user = userEvent.setup();
    const store = enrolled();
    const { unmount } = renderWithQuery(
      <CoursePlayer courseId={course} lectureId={L.lectureVideo} />,
    );
    expect((await screen.findByTestId('rating-blocked')).textContent).toBe(
      'Complete at least one lecture to leave a rating.',
    );
    expect(screen.getByRole('button', { name: 'Leave a rating' })).toHaveProperty('disabled', true);
    unmount();

    store.seedCompletion(FIXTURE_IDS.student, course, [L.lectureArticle]);
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    const open = await screen.findByRole('button', { name: 'Leave a rating' });
    await waitFor(() => expect(open).toHaveProperty('disabled', false));
    await user.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Rate this course' });
    await user.click(within(dialog).getByRole('radio', { name: '4 stars' }));
    await user.type(within(dialog).getByRole('textbox'), 'Great pace.');
    await user.click(within(dialog).getByRole('button', { name: 'Submit rating' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.myCourseReview(course).review).toMatchObject({ rating: 4, body: 'Great pace.' });
    expect(await screen.findByRole('button', { name: /Edit your rating/ })).toBeTruthy();
  });
});

describe('course completion', () => {
  it('shows the course-complete banner with the certificate link', async () => {
    const store = enrolled();
    store.seedCompletion(FIXTURE_IDS.student, course);
    renderWithQuery(<CoursePlayer courseId={course} lectureId={L.lectureVideo} />);
    const banner = await screen.findByTestId('course-complete');
    const [certificate] = store.myCertificates();
    expect(
      within(banner).getByRole('link', { name: 'View your certificate' }).getAttribute('href'),
    ).toBe(`/certificates/${certificate!.code}`);
  });
});
