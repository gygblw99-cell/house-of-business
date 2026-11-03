import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Default server address ────────────────────────────────────────────────────
// Change DEV_SERVER_IP to your computer's local network IP (found with ipconfig).
// This works for both physical devices on the same WiFi AND Android emulator.
export const DEV_SERVER_IP   = '192.168.1.54';
export const DEV_SERVER_PORT = 3001;

// PRODUCTION: set API_URL via react-native-config (.env file) or hardcode here before release
// Example: API_URL=https://api.houseofbusiness.co.il/api
const PROD_API_URL = process.env.API_URL || 'https://api.houseofbusiness.co.il/api';

export const DEFAULT_API_URL = __DEV__
  ? `http://${DEV_SERVER_IP}:${DEV_SERVER_PORT}/api`
  : PROD_API_URL;

const CONFIG_KEY = '@hob_server_url';

let _cachedUrl = null;

export async function getApiUrl() {
  if (_cachedUrl) return _cachedUrl;
  try {
    const saved = await AsyncStorage.getItem(CONFIG_KEY);
    _cachedUrl  = saved || DEFAULT_API_URL;
  } catch {
    _cachedUrl = DEFAULT_API_URL;
  }
  return _cachedUrl;
}

export async function setApiUrl(url) {
  _cachedUrl = url.replace(/\/$/, ''); // remove trailing slash
  await AsyncStorage.setItem(CONFIG_KEY, _cachedUrl);
}

export function resetCachedUrl() {
  _cachedUrl = null;
}
