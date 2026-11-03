import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import api from '../../services/api';

const BUSINESS_TYPES = ['restaurant','cafe','bar','bakery','barber','service'];
const TYPE_LABELS    = { restaurant:'מסעדה', cafe:'קפה', bar:'בר', bakery:'מאפייה', barber:'ספרות', service:'שירות' };

export default function RegisterScreen({ navigation }) {
  const [form, setForm] = useState({
    businessName: '', businessType: 'restaurant', email: '', password: '',
    ownerName: '', phone: '', address: '',
  });
  const [loading, setLoading] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleRegister = async () => {
    if (!form.businessName || !form.email || !form.password || !form.ownerName) {
      Alert.alert('שגיאה', 'נא למלא את כל שדות החובה');
      return;
    }
    if (!tosAccepted) {
      Alert.alert('תנאי שימוש', 'עליך לאשר את תנאי השימוש להמשיך');
      return;
    }
    setLoading(true);
    try {
      await api.register(form);
      Alert.alert('נרשמת בהצלחה!', 'כעת תוכל להתחבר', [
        { text: 'אישור', onPress: () => navigation.navigate('Login') },
      ]);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={s.back} onPress={() => navigation.goBack()}>
          <Text style={s.backText}>→ חזרה</Text>
        </TouchableOpacity>

        <Text style={s.title}>רישום עסק חדש</Text>

        <Text style={s.label}>שם העסק *</Text>
        <TextInput style={s.input} value={form.businessName} onChangeText={v => set('businessName', v)} textAlign="right" placeholderTextColor="#6B7280" placeholder="שם העסק" />

        <Text style={s.label}>סוג עסק</Text>
        <View style={s.typeRow}>
          {BUSINESS_TYPES.map(t => (
            <TouchableOpacity
              key={t}
              style={[s.typeBtn, form.businessType === t && s.typeBtnActive]}
              onPress={() => set('businessType', t)}
            >
              <Text style={[s.typeBtnText, form.businessType === t && s.typeBtnTextActive]}>
                {TYPE_LABELS[t]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.label}>שם הבעלים *</Text>
        <TextInput style={s.input} value={form.ownerName} onChangeText={v => set('ownerName', v)} textAlign="right" placeholderTextColor="#6B7280" placeholder="שם מלא" />

        <Text style={s.label}>מייל *</Text>
        <TextInput style={s.input} value={form.email} onChangeText={v => set('email', v)} keyboardType="email-address" autoCapitalize="none" textAlign="right" placeholderTextColor="#6B7280" placeholder="your@email.com" />

        <Text style={s.label}>סיסמה *</Text>
        <TextInput style={s.input} value={form.password} onChangeText={v => set('password', v)} secureTextEntry textAlign="right" placeholderTextColor="#6B7280" placeholder="לפחות 8 תווים" />

        <Text style={s.label}>טלפון</Text>
        <TextInput style={s.input} value={form.phone} onChangeText={v => set('phone', v)} keyboardType="phone-pad" textAlign="right" placeholderTextColor="#6B7280" placeholder="05X-XXXXXXX" />

        <Text style={s.label}>כתובת</Text>
        <TextInput style={s.input} value={form.address} onChangeText={v => set('address', v)} textAlign="right" placeholderTextColor="#6B7280" placeholder="רחוב, עיר" />

        {/* תנאי שימוש */}
        <TouchableOpacity style={s.tosRow} onPress={() => setTosAccepted(v => !v)}>
          <View style={[s.checkbox, tosAccepted && s.checkboxActive]}>
            {tosAccepted && <Text style={s.checkmark}>✓</Text>}
          </View>
          <Text style={s.tosText}>קראתי ואני מסכים לתנאי השימוש ומדיניות הפרטיות</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.btn, !tosAccepted && s.btnDisabled]}
          onPress={handleRegister}
          disabled={loading || !tosAccepted}
        >
          <Text style={s.btnText}>{loading ? 'נרשם...' : 'צור חשבון'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F0F1A' },
  inner:           { flexGrow: 1, padding: 24, paddingTop: 64 },
  back:            { marginBottom: 16 },
  backText:        { color: '#6366F1', fontSize: 16 },
  title:           { fontSize: 24, fontWeight: '700', color: '#F9FAFB', textAlign: 'center', marginBottom: 24 },
  label:           { color: '#9CA3AF', fontSize: 13, marginBottom: 6, textAlign: 'right' },
  input:           {
    backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12,
    padding: 14, marginBottom: 16, fontSize: 15, borderWidth: 1, borderColor: '#374151',
  },
  typeRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  typeBtn:         { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#374151' },
  typeBtnActive:   { backgroundColor: '#6366F1', borderColor: '#6366F1' },
  typeBtnText:     { color: '#9CA3AF', fontSize: 13 },
  typeBtnTextActive:{ color: '#fff', fontWeight: '600' },
  tosRow:          { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 24 },
  checkbox:        {
    width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#6366F1',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxActive:  { backgroundColor: '#6366F1' },
  checkmark:       { color: '#fff', fontWeight: '700', fontSize: 14 },
  tosText:         { flex: 1, color: '#9CA3AF', fontSize: 13, textAlign: 'right' },
  btn:             { backgroundColor: '#6366F1', borderRadius: 12, padding: 16, alignItems: 'center' },
  btnDisabled:     { opacity: 0.5 },
  btnText:         { color: '#fff', fontWeight: '700', fontSize: 16 },
});
