/**
 * "The file holds no Z rows" must never again look like "we could not read the
 * file".
 *
 * This is the QA finding: three days of "90 scanned, 0 imported" with ninety
 * error strings, while the pipeline was working. The AI extractor returned valid
 * JSON reporting zero Z-reports — a complete, correct answer — and because every
 * stage is gated on zReports.length > 0, that fell through to the same final
 * throw as a broken parser. Whoever read it went hunting for a parse bug when
 * the right question was whether the business had been closed.
 */

// The module graph reaches zreport.import.service, which calls db.migrate at
// load time, so the stub needs the full surface.
jest.mock('../src/utils/db', () => ({
  query:     jest.fn().mockResolvedValue({ rows: [] }),
  migrate:   jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
  pool:      { on: jest.fn(), end: jest.fn() },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { updateLastFetched } = require('../src/services/zreport.emailConfig.service');
const db = require('../src/utils/db');

/** The boolean updateLastFetched passes as $3 — whether it counts as success. */
async function successFlagFor(result) {
  db.query.mockClear();
  await updateLastFetched('biz-1', result);
  const params = db.query.mock.calls[0][1];
  return params[2];
}

describe('a clean scan that found nothing counts as success', () => {
  // The heart of the bug: success required imported > 0, so a closed business
  // froze last_success_at and every downstream reader called it an outage.
  test('files read, none held Z rows → success', async () => {
    expect(await successFlagFor({ scanned: 90, imported: 0, noData: 90, errors: [] })).toBe(true);
  });

  test('something imported → success', async () => {
    expect(await successFlagFor({ scanned: 5, imported: 3, noData: 0, errors: [] })).toBe(true);
  });

  test('scanned with nothing matching at all → success', async () => {
    expect(await successFlagFor({ scanned: 12, imported: 0, noData: 0, errors: [] })).toBe(true);
  });

  test('a real parse error → NOT success', async () => {
    expect(await successFlagFor({
      scanned: 10, imported: 0, noData: 0, errors: ['לא הצלחנו לקרוא את הקובץ'],
    })).toBe(false);
  });

  test('a connection failure → NOT success', async () => {
    expect(await successFlagFor({ scanned: 0, imported: 0, errors: ['auth'], _fetchFailed: true })).toBe(false);
  });

  test('nothing scanned and no error → NOT success, because nothing was verified', async () => {
    expect(await successFlagFor({ scanned: 0, imported: 0, noData: 0, errors: [] })).toBe(false);
  });

  test('imports still count even alongside one bad attachment', async () => {
    // A single unreadable file must not erase the evidence that the rest worked.
    expect(await successFlagFor({ scanned: 9, imported: 4, noData: 0, errors: ['one bad file'] })).toBe(true);
  });
});
