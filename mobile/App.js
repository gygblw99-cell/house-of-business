import React, { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { store } from './src/store';
import AppNavigator from './src/navigation/AppNavigator';
import { restoreSession, logout } from './src/store/slices/authSlice';
import { fetchUnreadCount } from './src/store/slices/notificationsSlice';
import { fetchDashboard } from './src/store/slices/dashboardSlice';
import messaging from '@react-native-firebase/messaging';
import PushNotification from 'react-native-push-notification';
import api, { setUnauthorizedHandler } from './src/services/api';

// Android notification channel (required for Android O+)
PushNotification.createChannel({ channelId: 'hob-alerts', channelName: 'House of Business Alerts', importance: 4, vibrate: true }, () => {});

function AppInner() {
  const dispatch    = useDispatch();
  const { user }    = useSelector(s => s.auth);
  const fcmDone     = useRef(false); // רישום פעם אחת בלבד per session
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    dispatch(restoreSession());
    // כשהשרת מחזיר 401 — logout אוטומטי ומעבר למסך Login
    setUnauthorizedHandler(() => dispatch(logout()));
  }, []);

  // רענון אוטומטי כשהאפליקציה חוזרת לפוראגראונד — סנכרון עם שינויים מהוובאפ
  useEffect(() => {
    if (!user) return;
    const sub = AppState.addEventListener('change', nextState => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        dispatch(fetchDashboard());
        dispatch(fetchUnreadCount());
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [user]);

  // רישום FCM רק כשמשתמש מחובר — כדי שיש auth token
  useEffect(() => {
    if (!user || fcmDone.current) return;
    fcmDone.current = true;
    _registerFCM();
  }, [user]);

  const _registerFCM = async () => {
    try {
      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (!enabled) return;

      const token = await messaging().getToken();
      if (token) {
        await api.registerPushToken(token, Platform.OS); // 'ios' | 'android'
      }

      // הודעות בפוראגראונד — הצג local notification + עדכן badge
      messaging().onMessage(async (remoteMessage) => {
        dispatch(fetchUnreadCount());
        const { title, body } = remoteMessage.notification || {};
        if (title) {
          PushNotification.localNotification({
            channelId: 'hob-alerts',
            title,
            message: body || '',
            playSound: true,
            soundName: 'default',
          });
        }
      });

      // רענון token — שלח לשרת אוטומטית
      messaging().onTokenRefresh(async (newToken) => {
        try { await api.registerPushToken(newToken, Platform.OS); } catch { /* non-fatal */ }
      });
    } catch { /* silent — אין firebase config */ }
  };

  return <AppNavigator />;
}

export default function App() {
  return (
    <Provider store={store}>
      <AppInner />
    </Provider>
  );
}
