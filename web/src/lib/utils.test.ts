import { getErrorMessage } from './utils';

describe('getErrorMessage', () => {
  // Regression test for a real bug: axios errors are `instanceof Error` too,
  // so checking `error instanceof Error` first always shadowed the backend's
  // actual Hebrew error string with axios's generic "Request failed with
  // status code 400" — every server-side validation message was silently
  // replaced with a useless generic one. The fix checks response.data.error
  // first; this test guards against that check ever moving back below the
  // instanceof check.
  it('prefers the backend-supplied error string over the generic axios message', () => {
    const axiosLikeError = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { error: 'שם ספק חסר' } },
    });
    expect(getErrorMessage(axiosLikeError)).toBe('שם ספק חסר');
  });

  it('falls back to response.data.message when .error is absent', () => {
    const axiosLikeError = Object.assign(new Error('Request failed with status code 500'), {
      response: { data: { message: 'שגיאת שרת פנימית' } },
    });
    expect(getErrorMessage(axiosLikeError)).toBe('שגיאת שרת פנימית');
  });

  it('falls back to error.message for a plain Error with no response payload', () => {
    expect(getErrorMessage(new Error('network down'))).toBe('network down');
  });

  it('returns a generic Hebrew fallback for a completely unknown error shape', () => {
    expect(getErrorMessage('just a string')).toBe('שגיאה לא ידועה');
    expect(getErrorMessage(null)).toBe('שגיאה לא ידועה');
    expect(getErrorMessage(undefined)).toBe('שגיאה לא ידועה');
  });
});
