'use strict';

/**
 * Upload storage — Cloudflare R2 when configured, local disk when not.
 *
 * Uploads used to live only on the container's filesystem, which Railway
 * replaces on every deploy: every scanned invoice and task photo was deleted
 * the next time we shipped. Attaching a Railway volume does not fix it — the
 * volume mounts owned by root while the app runs as another user, so writes
 * fail with EACCES (measured in production on 12.8.2026, see /health/storage).
 * Object storage sidesteps the ownership problem entirely and brings backup
 * and CDN delivery with it.
 *
 * Local disk stays the fallback rather than being removed, so a missing or
 * broken R2 configuration degrades to exactly today's behaviour instead of
 * breaking uploads outright. isRemote() reports which backend is live.
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const LOCAL_DIR = path.join(__dirname, '../../uploads');

const CFG = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKey: process.env.R2_ACCESS_KEY_ID,
  secretKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket:    process.env.R2_BUCKET,
};
const ENABLED = !!(CFG.accountId && CFG.accessKey && CFG.secretKey && CFG.bucket);

let _client = null;
let _sdk    = null;
function client() {
  if (_client) return _client;
  // Required lazily: the SDK is only needed when R2 is configured, and a
  // missing/broken dependency must not stop the server from booting — the
  // whole point of keeping the local fallback.
  _sdk = require('@aws-sdk/client-s3');
  _client = new _sdk.S3Client({
    region: 'auto',
    endpoint: `https://${CFG.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: CFG.accessKey, secretAccessKey: CFG.secretKey },
  });
  return _client;
}

function isRemote() { return ENABLED; }
function backendName() { return ENABLED ? 'r2' : 'local'; }

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
  return LOCAL_DIR;
}

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function contentTypeFor(filename) {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

/** Store a buffer under `filename`. */
async function put(filename, body, contentType) {
  if (!ENABLED) {
    ensureLocalDir();
    await fs.promises.writeFile(path.join(LOCAL_DIR, filename), body);
    return { backend: 'local' };
  }
  await client().send(new _sdk.PutObjectCommand({
    Bucket: CFG.bucket, Key: filename, Body: body,
    ContentType: contentType || contentTypeFor(filename),
  }));
  return { backend: 'r2' };
}

/** Copy an already-written local file into storage, then drop the local copy. */
async function putFromFile(localPath, filename) {
  if (!ENABLED) return { backend: 'local' };
  const body = await fs.promises.readFile(localPath);
  const res = await put(filename, body);
  // Only after a confirmed upload — deleting first would lose the file if the
  // upload then failed.
  await fs.promises.unlink(localPath).catch(() => {});
  return res;
}

/** Returns { stream, contentType, contentLength } or null when absent. */
async function getStream(filename) {
  if (ENABLED) {
    try {
      const r = await client().send(new _sdk.GetObjectCommand({ Bucket: CFG.bucket, Key: filename }));
      return { stream: r.Body, contentType: r.ContentType, contentLength: r.ContentLength };
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        // Fall through to disk: files uploaded before R2 was switched on still
        // live there, so this keeps them reachable instead of 404ing history.
      } else {
        throw err;
      }
    }
  }
  const local = path.join(LOCAL_DIR, filename);
  if (!fs.existsSync(local)) return null;
  return { stream: fs.createReadStream(local), contentType: contentTypeFor(filename) };
}

/** Returns true if the file exists in storage (no stream opened). */
async function exists(filename) {
  if (ENABLED) {
    try {
      await client().send(new _sdk.HeadObjectCommand({ Bucket: CFG.bucket, Key: filename }));
      return true;
    } catch (err) {
      const status = err?.$metadata?.httpStatusCode;
      if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
        // Definitively absent in R2 — fall through to local disk
      } else {
        // R2 unreachable / other error — treat as unknown, not missing
        return null;
      }
    }
  }
  return fs.existsSync(path.join(LOCAL_DIR, filename));
}

async function remove(filename) {
  if (ENABLED) {
    await client().send(new _sdk.DeleteObjectCommand({ Bucket: CFG.bucket, Key: filename }))
      .catch(err => logger.warn('[storage] R2 delete failed', { filename, err: err.message }));
  }
  await fs.promises.unlink(path.join(LOCAL_DIR, filename)).catch(() => {});
}

/** Round-trip probe used by GET /health/storage. */
async function healthCheck() {
  const key = `.probe-${Date.now()}`;
  const steps = { write: false, read: false, delete: false };
  try {
    await put(key, Buffer.from('ok'), 'text/plain');            steps.write = true;
    const got = await getStream(key);
    if (got?.stream) {
      // Drain it — a handle that opens but can't be read is still a failure.
      if (ENABLED) await got.stream.transformToString();
      else await new Promise((res, rej) => { got.stream.on('end', res).on('error', rej).resume(); });
      steps.read = true;
    }
    await remove(key);                                          steps.delete = true;
    return { ok: steps.write && steps.read && steps.delete, backend: backendName(), steps };
  } catch (err) {
    return { ok: false, backend: backendName(), steps, code: err.code || err.name, error: err.message };
  }
}

module.exports = {
  isRemote, backendName, put, putFromFile, getStream, exists, remove,
  healthCheck, ensureLocalDir, contentTypeFor, LOCAL_DIR,
};
