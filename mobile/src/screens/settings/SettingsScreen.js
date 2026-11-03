import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../../store/slices/authSlice';
import { getApiUrl, setApiUrl, DEFAULT_API_URL, resetCachedUrl } from '../../config';
import ScreenHeader from '../../components/ScreenHeader';

export default function SettingsScreen({ navigation }) {
  const dispatch = useDispatch();
  const { user } = useSelector(s => s.auth);
  const [serverUrl,    setServerUrl]    = useState('');
  const [editingUrl,   setEditingUrl]   = useState(false);
  const [urlDraft,     setUrlDraft]     = useState('');

  useEffect(() => {
    getApiUrl().then(url => { setServerUrl(url); setUrlDraft(url); });
  }, []);

  const handleSaveUrl = async () => {
    const trimmed = urlDraft.trim().replace(/\/$/, '');
    if (!trimmed.startsWith('http')) {
      Alert.alert('שגיאה', 'הכתובת חייבת להתחיל ב-http:// או https://');
      return;
    }
    await setApiUrl(trimmed);
    resetCachedUrl();
    setServerUrl(trimmed);
    setEditingUrl(false);
    Alert.alert('נשמר', 'כתובת השרת עודכנה. נא להתחבר מחדש.');
  };

  const handleResetUrl = async () => {
    await setApiUrl(DEFAULT_API_URL);
    resetCachedUrl();
    setServerUrl(DEFAULT_API_URL);
    setUrlDraft(DEFAULT_API_URL);
    setEditingUrl(false);
    Alert.alert('אופס', 'הכתובת אופסה לברירת המחדל');
  };

  const handleLogout = () => {
    Alert.alert('יציאה', 'האם לצאת מהחשבון?', [
      { text: 'ביטול', style: 'cancel' },
      { text: 'יצא', style: 'destructive', onPress: () => dispatch(logout()) },
    ]);
  };

  const ROLE_LABELS = { owner: 'בעלים', manager: 'מנהל', employee: 'עובד', partner: 'שותף' };

  const MenuItem = ({ icon, label, onPress, danger }) => (
    <TouchableOpacity style={s.menuItem} onPress={onPress}>
      <Text style={s.menuArrow}>←</Text>
      <Text style={[s.menuLabel, danger && s.menuLabelDanger]}>{label}</Text>
      <Text style={s.menuIcon}>{icon}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={s.container}>
      <ScreenHeader
        title="הגדרות"
        left={<TouchableOpacity onPress={() => navigation.goBack()}><Text style={s.back}>→ חזרה</Text></TouchableOpacity>}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* פרטי משתמש */}
        <View style={s.userCard}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{user?.name?.charAt(0) || '?'}</Text>
          </View>
          <View>
            <Text style={s.userName}>{user?.name || '—'}</Text>
            <Text style={s.userRole}>{ROLE_LABELS[user?.role] || user?.role}</Text>
            <Text style={s.userEmail}>{user?.email || ''}</Text>
          </View>
        </View>

        <Text style={s.sectionTitle}>עסק</Text>
        <MenuItem icon="🏢" label="פרטי העסק"   onPress={() => {}} />
        <MenuItem icon="👥" label="ניהול עובדים" onPress={() => navigation.navigate('Employees')} />
        <MenuItem icon="📊" label="ביקורת עסקית" onPress={() => navigation.navigate('Audit')} />
        <MenuItem icon="📋" label="לוג פעילות"   onPress={() => {}} />

        <Text style={s.sectionTitle}>חשבון</Text>
        <MenuItem icon="🔒" label="שינוי סיסמה"  onPress={() => {}} />
        <MenuItem icon="🔔" label="התראות"        onPress={() => navigation.navigate('Notifications')} />

        {/* כתובת שרת — כלי פיתוח בלבד: שינוי כתובת ה-API שולח את ה-JWT של המשתמש
            לשרת שרירותי בכל בקשה עתידית; אין לחשוף את זה למשתמש קצה בפרודקשן */}
        {__DEV__ && (
          <>
            <Text style={s.sectionTitle}>חיבור לשרת</Text>
            <View style={s.serverCard}>
              <Text style={s.serverLabel}>כתובת ה-API</Text>
              {editingUrl ? (
                <>
                  <TextInput
                    style={s.serverInput}
                    value={urlDraft}
                    onChangeText={setUrlDraft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="http://192.168.1.54:3001/api"
                    placeholderTextColor="#6B7280"
                  />
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <TouchableOpacity style={s.btnSmall} onPress={handleSaveUrl}>
                      <Text style={s.btnSmallText}>שמור</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.btnSmall, s.btnSmallGray]} onPress={() => { setEditingUrl(false); setUrlDraft(serverUrl); }}>
                      <Text style={[s.btnSmallText, { color: '#9CA3AF' }]}>ביטול</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.btnSmall, s.btnSmallRed]} onPress={handleResetUrl}>
                      <Text style={[s.btnSmallText, { color: '#EF4444' }]}>איפוס</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <TouchableOpacity onPress={() => setEditingUrl(true)}>
                  <Text style={s.serverValue}>{serverUrl}</Text>
                  <Text style={s.serverHint}>לחץ לשינוי</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

        <Text style={s.sectionTitle}>מידע</Text>
        <MenuItem icon="📄" label="תנאי שימוש"   onPress={() => {}} />
        <MenuItem icon="🔏" label="מדיניות פרטיות" onPress={() => {}} />
        <View style={s.version}>
          <Text style={s.versionText}>House of Business v1.0.0</Text>
        </View>

        <MenuItem icon="🚪" label="יציאה מהחשבון" onPress={handleLogout} danger />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  back:            { color: '#6366F1', fontSize: 15 },
  userCard:        { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#1E1E2E', borderRadius: 16, padding: 20, marginBottom: 24 },
  avatar:          { width: 56, height: 56, borderRadius: 28, backgroundColor: '#6366F1', alignItems: 'center', justifyContent: 'center' },
  avatarText:      { color: '#fff', fontSize: 24, fontWeight: '700' },
  userName:        { color: '#F9FAFB', fontSize: 17, fontWeight: '700', textAlign: 'right' },
  userRole:        { color: '#9CA3AF', fontSize: 13, textAlign: 'right', marginTop: 2 },
  userEmail:       { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 2 },
  sectionTitle:    { color: '#6B7280', fontSize: 12, fontWeight: '600', textAlign: 'right', marginBottom: 8, marginTop: 16 },
  menuItem:        { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16, marginBottom: 4 },
  menuIcon:        { fontSize: 20, width: 32 },
  menuLabel:       { flex: 1, color: '#F9FAFB', fontSize: 15, textAlign: 'right', marginRight: 12 },
  menuLabelDanger: { color: '#EF4444' },
  menuArrow:       { color: '#6B7280', fontSize: 18 },
  version:         { alignItems: 'center', paddingVertical: 16 },
  versionText:     { color: '#374151', fontSize: 12 },
  serverCard:      { backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16, marginBottom: 4 },
  serverLabel:     { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginBottom: 6 },
  serverValue:     { color: '#6366F1', fontSize: 13, textAlign: 'right', fontFamily: 'monospace' },
  serverHint:      { color: '#374151', fontSize: 11, textAlign: 'right', marginTop: 4 },
  serverInput:     { backgroundColor: '#0F0F1A', color: '#F9FAFB', borderRadius: 8, padding: 10, fontSize: 13, borderWidth: 1, borderColor: '#374151', textAlign: 'left' },
  btnSmall:        { backgroundColor: '#6366F1', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  btnSmallGray:    { backgroundColor: '#1E1E2E', borderWidth: 1, borderColor: '#374151' },
  btnSmallRed:     { backgroundColor: '#1E1E2E', borderWidth: 1, borderColor: '#EF4444' },
  btnSmallText:    { color: '#fff', fontSize: 13, fontWeight: '600' },
});
