import { describe, expect, it, vi } from 'vitest';

import { readFragmentToken, takeFragmentToken } from './fragment-token';

describe('readFragmentToken', () => {
  it('reads the token from the fragment', () => {
    expect(readFragmentToken('#token=abc123')).toBe('abc123');
    expect(readFragmentToken('token=abc123')).toBe('abc123');
  });

  it('decodes percent-encoding and ignores other parameters', () => {
    expect(readFragmentToken('#utm=x&token=a%2Bb~c&y=1')).toBe('a+b~c');
  });

  it('returns null when there is no usable token', () => {
    expect(readFragmentToken('')).toBeNull();
    expect(readFragmentToken('#')).toBeNull();
    expect(readFragmentToken('#other=1')).toBeNull();
    expect(readFragmentToken('#token=')).toBeNull();
    expect(readFragmentToken(`#token=${'a'.repeat(513)}`)).toBeNull();
  });
});

describe('takeFragmentToken', () => {
  it('returns the token and strips the fragment, keeping path, query and history state', () => {
    const history = { state: { __NA: true }, replaceState: vi.fn() };
    const token = takeFragmentToken(
      { hash: '#token=t0k', pathname: '/reset-password', search: '?x=1' },
      history,
    );
    expect(token).toBe('t0k');
    expect(history.replaceState).toHaveBeenCalledWith({ __NA: true }, '', '/reset-password?x=1');
  });

  it('strips a fragment even when it holds no token', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(
      takeFragmentToken({ hash: '#junk', pathname: '/verify-email', search: '' }, history),
    ).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/verify-email');
  });

  it('leaves the history alone when there is no fragment', () => {
    const history = { state: null, replaceState: vi.fn() };
    expect(
      takeFragmentToken({ hash: '', pathname: '/verify-email', search: '' }, history),
    ).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
