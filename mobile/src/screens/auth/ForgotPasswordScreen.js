import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../../services/api';

export default function ForgotPasswordScreen({ navigation }) {
  const [phone,   setPhone]   = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!phone.trim()) { Alert.alert('שגיאה', 'יש להזין מספר טלפון'); return; }
    setLoading(true);
    try {
      await api.forgotPassword(phone.trim());
      Alert.alert(
        'קוד נשלח',
        'קוד אימות נשלח למספר הטלפון שלך',
        [{ text: 'המשך', onPress: () => navigation.navigate('ResetPassword', { phone: phone.trim() }) }]
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
        <Text style={s.title}>שחזור סיסמה</Text>
        <Text style={s.subtitle}>הזן את מספר הטלפון שרשמת בעת ההצטרפות</Text>

        <Text style={s.label}>מספר טלפון</Text>
        <TextInput
          style={s.input}
          placeholder="050-0000000"
          placeholderTextColor="#6B7280"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          textAlign="right"
          autoFocus
        />

        <TouchableOpacity
          style={[s.btn, loading && s.btnDisabled]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.btnText}>שלח קוד אימות</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backLink}>
          <Text style={s.backText}>← חזרה להתחברות</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0F0F1A' },
  inner:       { flex: 1, padding: 28, justifyContent: 'center' },
  title:       { color: '#F9FAFB', fontSize: 26, fontWeight: '700', textAlign: 'right', marginBottom: 8 },
  subtitle:    { color: '#9CA3AF', fontSize: 14, textAlign: 'right', marginBottom: 32 },
  label:       { color: '#D1D5DB', fontSize: 14, fontWeight: '600', textAlign: 'right', marginBottom: 8 },
  input:       { backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12, padding: 16, fontSize: 17, marginBottom: 24, borderWidth: 1, borderColor: '#374151' },
  btn:         { backgroundColor: '#6366F1', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 16 },
  btnDisabled: { opacity: 0.6 },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  backLink:    { alignItems: 'center', marginTop: 8 },
  backText:    { color: '#6366F1', fontSize: 14 },
});
