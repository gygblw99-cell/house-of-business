import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal,
} from 'react-native';
import { RNCamera } from 'react-native-camera';
import api from '../../services/api';
import ScreenHeader from '../../components/ScreenHeader';

// QR מכיל URL בפורמט .../clock-in?b=<businessId>&t=<token> — נשלוף רק את ה-token.
// אם הסריקה מחזירה מחרוזת token גולמית (בלי URL) — נשתמש בה כמו שהיא.
function extractToken(scannedData) {
  const match = /[?&]t=([^&]+)/.exec(scannedData || '');
  return match ? decodeURIComponent(match[1]) : scannedData;
}

export default function ClockInScreen({ navigation }) {
  const [loading,     setLoading]     = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [checking,    setChecking]    = useState(true);
  const [scanning,    setScanning]    = useState(false);
  const [scanLock,    setScanLock]    = useState(false);

  useEffect(() => {
    checkActiveShift();
  }, []);

  const checkActiveShift = async () => {
    try {
      const { shift } = await api.getMyActiveShift();
      setActiveShift(shift || null);
    } catch { /* silent */ }
    finally { setChecking(false); }
  };

  const handleBarCodeRead = async ({ data }) => {
    if (scanLock || loading) return;
    setScanLock(true);
    setLoading(true);
    try {
      const token = extractToken(data);
      await api.clockInQR(token);
      setScanning(false);
      Alert.alert('✅ כניסה למשמרת', 'שעת הכניסה נרשמה בהצלחה', [
        { text: 'אישור', onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      setScanning(false);
      Alert.alert('שגיאה', err.message);
    } finally {
      setLoading(false);
      setScanLock(false);
    }
  };

  const handleClockOut = async () => {
    Alert.alert('יציאה ממשמרת', 'האם לסיים את המשמרת?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'כן, צא',
        style: 'destructive',
        onPress: async () => {
          setLoading(true);
          try {
            const shift = await api.clockOut();
            Alert.alert('✅ יציאה ממשמרת', `עבדת ${shift.hoursWorked} שעות`, [
              { text: 'אישור', onPress: () => navigation.goBack() },
            ]);
          } catch (err) {
            Alert.alert('שגיאה', err.message);
          } finally { setLoading(false); }
        },
      },
    ]);
  };

  if (checking) return <ActivityIndicator color="#6366F1" style={{ flex: 1, backgroundColor: '#0F0F1A' }} />;

  return (
    <View style={s.container}>
      <ScreenHeader title="שעון נוכחות" />

      <View style={s.content}>
        <Text style={s.statusIcon}>{activeShift ? '🟢' : '⚫'}</Text>
        <Text style={s.statusText}>{activeShift ? 'במשמרת פעילה' : 'לא במשמרת'}</Text>

        {activeShift && (
          <Text style={s.sinceText}>
            מאז {new Date(activeShift.actual_start).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}

        {!activeShift ? (
          <>
            <TouchableOpacity
              style={[s.btn, s.btnIn, loading && s.btnDisabled]}
              onPress={() => setScanning(true)}
              disabled={loading}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>📷 סרוק QR לכניסה</Text>}
            </TouchableOpacity>
            <Text style={s.hintText}>בקש מהמנהל להציג את קוד ה-QR של העסק וסרוק אותו</Text>
          </>
        ) : (
          <TouchableOpacity
            style={[s.btn, s.btnOut, loading && s.btnDisabled]}
            onPress={handleClockOut}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>יציאה ממשמרת</Text>}
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={s.scannerContainer}>
          <RNCamera
            style={StyleSheet.absoluteFill}
            type={RNCamera.Constants.Type.back}
            onBarCodeRead={handleBarCodeRead}
            barCodeTypes={[RNCamera.Constants.BarCodeType.qr]}
            captureAudio={false}
            androidCameraPermissionOptions={{
              title: 'הרשאת מצלמה',
              message: 'האפליקציה צריכה גישה למצלמה כדי לסרוק את קוד ה-QR לכניסה למשמרת',
              buttonPositive: 'אישור',
              buttonNegative: 'ביטול',
            }}
          />
          <View style={s.scannerOverlay} pointerEvents="box-none">
            <Text style={s.scannerHint}>כוון את המצלמה לקוד ה-QR שהמנהל מציג</Text>
            <TouchableOpacity style={s.scannerClose} onPress={() => setScanning(false)}>
              <Text style={s.scannerCloseText}>✕ ביטול</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F0F1A' },
  content:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  statusIcon:   { fontSize: 64, marginBottom: 16 },
  statusText:   { color: '#F9FAFB', fontSize: 24, fontWeight: '700', marginBottom: 8 },
  sinceText:    { color: '#9CA3AF', fontSize: 16, marginBottom: 24 },
  btn:          { borderRadius: 16, paddingVertical: 18, paddingHorizontal: 48, marginBottom: 16, marginTop: 24 },
  btnIn:        { backgroundColor: '#10B981' },
  btnOut:       { backgroundColor: '#EF4444' },
  btnDisabled:  { opacity: 0.5 },
  btnText:      { color: '#fff', fontSize: 18, fontWeight: '700' },
  hintText:     { color: '#6B7280', fontSize: 13, textAlign: 'center', maxWidth: 260 },
  scannerContainer: { flex: 1, backgroundColor: '#000' },
  scannerOverlay:   { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 48 },
  scannerHint:      { color: '#F9FAFB', fontSize: 15, marginBottom: 20, textAlign: 'center', paddingHorizontal: 24 },
  scannerClose:     { backgroundColor: '#1E1E2E', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32 },
  scannerCloseText: { color: '#F9FAFB', fontSize: 16, fontWeight: '700' },
});
