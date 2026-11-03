/**
 * Push Notification Service
 * Firebase Cloud Messaging — שליחת התראות למובייל
 */

let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
} catch {
  admin = null;
}

const db     = require('../../utils/db');
const logger = require('../../utils/logger');

// שליחה לעובד / מנהל ספציפי
async function sendToUser(userId, { title, body, data = {} }) {
  try {
    // The column is push_token. This whole module was written against
    // fcm_token / platform / enabled — three columns push_settings has never
    // had — so every query here threw 42703, the catch below swallowed it and
    // returned { sent: 0 }, and push notifications have never once been
    // delivered. "sent: 0" is indistinguishable from "nobody registered",
    // which is why it went unnoticed. A token being present IS the enabled
    // signal; the table's other flags are per-notification-type preferences,
    // not a master switch.
    const { rows } = await db.query(
      `SELECT ps.push_token FROM push_settings ps
       WHERE ps.user_id = $1 AND ps.push_token IS NOT NULL`,
      [userId]
    );

    if (!rows.length || !admin) return { sent: 0 };

    const results = await Promise.allSettled(
      rows.map(r =>
        admin.messaging().send({
          token:        r.push_token,
          notification: { title, body },
          data:         Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
          android:      { priority: 'high' },
          apns:         { payload: { aps: { sound: 'default' } } },
        })
      )
    );

    const sent   = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    return { sent, failed };
  } catch (err) {
    logger.error('[Push] sendToUser error', { userId, err: err.message });
    return { sent: 0, error: err.message };
  }
}

// שליחה לכל העסק (מנהלים בלבד)
async function sendToManagers(businessId, { title, body, data = {} }) {
  try {
    const { rows } = await db.query(
      `SELECT ps.push_token FROM push_settings ps
       INNER JOIN users u ON u.id = ps.user_id
       WHERE u.business_id = $1 AND u.role IN ('owner','manager')
         AND ps.push_token IS NOT NULL`,
      [businessId]
    );

    if (!rows.length || !admin) return { sent: 0 };

    const results = await Promise.allSettled(
      rows.map(r =>
        admin.messaging().send({
          token:        r.push_token,
          notification: { title, body },
          data:         Object.fromEntries(Object.entries(data).map(([k,v]) => [k, String(v)])),
        })
      )
    );

    return { sent: results.filter(r => r.status === 'fulfilled').length };
  } catch (err) {
    // Was returning silently. A broken query here is indistinguishable from
    // "no managers registered", which is exactly how the fcm_token schema
    // mismatch above stayed invisible for the lifetime of this module.
    logger.error('[Push] sendToManagers error', { businessId, err: err.message });
    return { sent: 0, error: err.message };
  }
}

// שמירת / עדכון FCM token
async function registerToken(userId, fcmToken, platform = 'android') {
  await db.query(
    // platform was never a push_settings column either, so this INSERT threw
    // on every call — meaning POST /api/notifications/register-token 500'd and
    // no device could ever register in the first place.
    `INSERT INTO push_settings (user_id, push_token)
     VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE
     SET push_token = EXCLUDED.push_token,
         updated_at = NOW()`,
    [userId, fcmToken]
  );
}

// ביטול הרשאה
async function unregisterToken(userId) {
  await db.query(
    `UPDATE push_settings SET push_token = NULL, updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );
}

module.exports = { sendToUser, sendToManagers, registerToken, unregisterToken };
