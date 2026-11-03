/**
 * Push Notification Service
 * Handles FCM token registration and foreground notification display.
 * Called once after successful login.
 */

import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import PushNotification from 'react-native-push-notification';
import api from './api';

// Configure local notification channels (Android O+)
PushNotification.createChannel(
  {
    channelId: 'hob-alerts',
    channelName: 'House of Business Alerts',
    channelDescription: 'Business alerts and reminders',
    importance: 4, // HIGH
    vibrate: true,
  },
  () => {}
);

/**
 * Request permission, obtain FCM token, and register it with the backend.
 * Safe to call multiple times — backend upserts on (user_id, token).
 */
export async function registerPushToken() {
  try {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) return;

    const fcmToken = await messaging().getToken();
    if (!fcmToken) return;

    await api.post('/notifications/token', {
      fcmToken,
      platform: Platform.OS, // 'ios' | 'android'
    });
  } catch (err) {
    // Non-fatal — app works without push notifications
    console.warn('[Push] Failed to register FCM token:', err?.message);
  }
}

/**
 * Show a local notification when the app is in the foreground.
 * Background / quit messages are handled by native FCM automatically.
 */
export function setupForegroundNotifications() {
  return messaging().onMessage(async (remoteMessage) => {
    const { title, body } = remoteMessage.notification || {};
    if (!title) return;

    PushNotification.localNotification({
      channelId:   'hob-alerts',
      title,
      message:     body || '',
      playSound:   true,
      soundName:   'default',
      importance:  'high',
      vibrate:     true,
    });
  });
}

/**
 * Handle token refresh — re-register with backend automatically.
 */
export function setupTokenRefresh() {
  return messaging().onTokenRefresh(async (newToken) => {
    try {
      await api.post('/notifications/token', {
        fcmToken: newToken,
        platform: Platform.OS,
      });
    } catch {
      // Non-fatal
    }
  });
}
