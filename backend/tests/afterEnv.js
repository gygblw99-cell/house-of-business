/**
 * Per-suite teardown.
 *
 * About 15 test files require('../src/index'), and utils/db.js opens a pg.Pool
 * at module load. Nothing ever closed it, so every one of those suites finished
 * holding a live pool and Jest reported "A worker process has failed to exit
 * gracefully" on most runs. db.js has exported closePool() all along — it was
 * simply never called from the tests.
 *
 * This has to live in setupFilesAfterEnv rather than setupFiles: afterAll does
 * not exist yet when setupFiles runs. Each test file gets its own module
 * registry, so the db required here is the same instance that file used.
 */

afterAll(async () => {
  try {
    const db = require('../src/utils/db');
    // A mocked db (most unit suites jest.mock it) has no closePool.
    if (typeof db.closePool === 'function') await db.closePool();
  } catch {
    // The suite never loaded db, or it is already closed — nothing to do.
  }
});
