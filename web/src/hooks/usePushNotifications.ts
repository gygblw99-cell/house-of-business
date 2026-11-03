'use client';

import { useEffect, useRef } from 'react';
import { getFirebaseMessaging, getToken, onMessage, VAPID_KEY } from '@/lib/firebase';
import api from '@/lib/api/client';

export function usePushNotifications(enabled: boolean) {
  const registered = useRef(false);

  useEffect(() => {
    if (!enabled || registered.current || !VAPID_KEY) return;

    async function register() {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const messaging = getFirebaseMessaging();
        if (!messaging) return;

        const token = await getToken(messaging, {
          vapidKey:        VAPID_KEY!,
          serviceWorkerRegistration: await navigator.serviceWorker.register('/firebase-messaging-sw.js'),
        });

        if (token) {
          await api.post('/notifications/token', {
            fcmToken: token,
            platform: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 'android' : 'web',
          });
          registered.current = true;
        }
      } catch {
        // fail silently — push is opt-in, not critical
      }
    }

    register();
  }, [enabled]);

  useEffect(() => {
    if (!VAPID_KEY) return;
    const messaging = getFirebaseMessaging();
    if (!messaging) return;

    const unsub = onMessage(messaging, (payload) => {
      const { title, body } = payload.notification ?? {};
      if (title && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icon-192.png' });
      }
    });

    return unsub;
  }, []);
}
