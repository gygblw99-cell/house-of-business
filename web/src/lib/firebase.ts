import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, onMessage, type Messaging } from 'firebase/messaging';

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const isConfigured = Object.values(firebaseConfig).every(Boolean);

const app = isConfigured && !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];

export function getFirebaseMessaging(): Messaging | null {
  if (!isConfigured || typeof window === 'undefined') return null;
  try {
    return getMessaging(app);
  } catch {
    return null;
  }
}

export { getToken, onMessage };
export const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
