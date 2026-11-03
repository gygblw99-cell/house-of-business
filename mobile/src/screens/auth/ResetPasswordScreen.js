import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../../services/api';

export default function ResetPasswordScreen({ navigation, route }) {
  const phone = route.params?.phone || '';
  const [code,        setCode]        = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm,     setConfirm]     = useState('');
  const [loading,     setLoading]     = useState(false);

  const handleReset = async () => {
    if (!code.trim())        { Alert.alert('שגיאה', 'יש להזין קוד אימות'); return; }
    if (newPassword.length < 6) { Alert.alert('שגיאה', 'הסיסמה חייבת להכיל לפחות 6 תווים'); return; }
    if (newPassword !== confirm) { Alert.alert('שגיאה', 'הסיסמאות אינן תואמות'); return; }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { phone, code: code.trim(), newPassword });
      Alert.alert(
        '✅ סיסמה שונתה',
        'הסיסמה עודכנה בהצלחה',
        [{ text: 'כניסה', onPress: () => navigation.navigate('Login') }]
      );
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={s.inner}>
        <Text style={s.title}>סיסמה חדשה</Text>
        <Text style={s.subtitle}>הזן את הקוד שקיבלת ב-SMS וצור סיסמה חדשה</Text>

        <Text style={s.label}>קוד אימות</Text>
        <TextInput
          style={s.input}
          placeholder="6 ספרות"
          placeholderTextColor="#6B7280"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
          textAlign="center"
          autoFocus
        />

        <Text style={s.label}>סיסמה חדשה</Text>
        <TextInput
          style={s.input}
          placeholder="לפחות 6 תווים"
          placeholderTextColor="#6B7280"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          textAlign="right"
        />

        <Text style={s.label}>אימות סיסמה</Text>
        <TextInput
          style={s.input}
          placeholder="חזור על הסיסמה"
          placeholderTextColor="#6B7280"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          textAlign="right"
        />

        <TouchableOpacity
          style={[s.btn, loading && s.btnDisabled]}
          onPress={handleReset}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.btnText}>שנה סיסמה</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backLink}>
          <Text style={s.backText}>← חזרה</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0F0F1A' },
  inner:       { flex: 1, padding: 28, justifyContent: 'center' },
  title:       { color: '#F9FAFB', fontSize: 26, fontWeight: '700', textAlign: 'right', marginBottom: 8 },
  subtitle:    { color: '#9CA3AF', fontSize: 14, textAlign: 'right', marginBottom: 28 },
  label:       { color: '#D1D5DB', fontSize: 14, fontWeight: '600', textAlign: 'right', marginBottom: 8 },
  input:       { backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 16, fontSize: 16, marginBottom: 16, borderWidth: 1, borderColor: '#374151' },
  btn:         { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8, marginBottom: 16 },
  btnDisabled: { opacity: 0.6 },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  backLink:    { alignItems: 'center' },
  backText:    { color: '#6366F1', fontSize: 14 },
});
