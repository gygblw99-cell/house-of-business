import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { loginOwner, clearError } from '../../store/slices/authSlice';

export default function LoginScreen({ navigation }) {
  const dispatch = useDispatch();
  const { loading, error } = useSelector(s => s.auth);

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    if (!email.trim() || !password) {
      Alert.alert('שגיאה', 'נא למלא מייל וסיסמה');
      return;
    }
    const result = await dispatch(loginOwner({ email: email.trim(), password }));
    if (loginOwner.rejected.match(result)) {
      Alert.alert('כניסה נכשלה', result.payload);
    }
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <Text style={s.logo}>🏢</Text>
        <Text style={s.title}>House of Business</Text>
        <Text style={s.subtitle}>כניסה לבעלים / מנהלים</Text>

        <TextInput
          style={s.input}
          placeholder="מייל"
          placeholderTextColor="#6B7280"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          textAlign="right"
        />
        <TextInput
          style={s.input}
          placeholder="סיסמה"
          placeholderTextColor="#6B7280"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textAlign="right"
        />

        <TouchableOpacity style={s.btn} onPress={handleLogin} disabled={loading}>
          <Text style={s.btnText}>{loading ? 'מתחבר...' : 'כניסה'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.link}
          onPress={() => navigation.navigate('ForgotPassword')}
        >
          <Text style={s.linkText}>שכחתי סיסמה</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.btn, s.btnSecondary]}
          onPress={() => navigation.navigate('EmployeeLogin')}
        >
          <Text style={[s.btnText, { color: '#6366F1' }]}>כניסת עובד</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.link}
          onPress={() => navigation.navigate('Register')}
        >
          <Text style={s.linkText}>עסק חדש? הרשמה</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#0F0F1A' },
  inner:       { flexGrow: 1, justifyContent: 'center', padding: 24 },
  logo:        { fontSize: 56, textAlign: 'center', marginBottom: 8 },
  title:       { fontSize: 26, fontWeight: '700', color: '#F9FAFB', textAlign: 'center', marginBottom: 4 },
  subtitle:    { fontSize: 14, color: '#9CA3AF', textAlign: 'center', marginBottom: 32 },
  input:       {
    backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12,
    padding: 14, marginBottom: 12, fontSize: 16,
    borderWidth: 1, borderColor: '#374151',
  },
  btn:         {
    backgroundColor: '#6366F1', borderRadius: 12,
    padding: 16, alignItems: 'center', marginTop: 8,
  },
  btnSecondary:{ backgroundColor: 'transparent', borderWidth: 1, borderColor: '#6366F1', marginTop: 12 },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
  link:        { marginTop: 16, alignItems: 'center' },
  linkText:    { color: '#6366F1', fontSize: 14 },
});
