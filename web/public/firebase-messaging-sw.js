// Firebase Messaging Service Worker
// מקבל התראות push ברקע כשהאפליקציה סגורה

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ערכים מוזרקים ב-build על ידי Next.js (next.config.ts → serviceWorker env)
// אם חסרים — SW נטען בשקט בלי להתרסק
const config = {
  apiKey:            self.__FIREBASE_API_KEY__            || '',
  authDomain:        self.__FIREBASE_AUTH_DOMAIN__        || '',
  projectId:         self.__FIREBASE_PROJECT_ID__         || '',
  storageBucket:     self.__FIREBASE_STORAGE_BUCKET__     || '',
  messagingSenderId: self.__FIREBASE_MESSAGING_SENDER_ID__ || '',
  appId:             self.__FIREBASE_APP_ID__             || '',
};

if (config.apiKey) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const { title = 'House of Business', body = '' } = payload.notification ?? {};
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
    });
  });
}
