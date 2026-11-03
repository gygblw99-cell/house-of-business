import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { loginEmployee } from '../../store/slices/authSlice';

export default function EmployeeLoginScreen({ navigation }) {
  const dispatch = useDispatch();
  const { loading } = useSelector(s => s.auth);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      Alert.alert('שגיאה', 'נא למלא שם משתמש וסיסמה');
      return;
    }
    const result = await dispatch(loginEmployee({ username: username.trim(), password }));
    if (loginEmployee.rejected.match(result)) {
      Alert.alert('כניסה נכשלה', result.payload);
    }
  };

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.inner}>
        <TouchableOpacity style={s.back} onPress={() => navigation.goBack()}>
          <Text style={s.backText}>→ חזרה</Text>
        </TouchableOpacity>

        <Text style={s.title}>כניסת עובד</Text>

        <TextInput
          style={s.input}
          placeholder="שם משתמש"
          placeholderTextColor="#6B7280"
          value={username}
          onChangeText={setUsername}
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
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  inner:     { flex: 1, justifyContent: 'center', padding: 24 },
  back:      { position: 'absolute', top: 56, right: 24 },
  backText:  { color: '#6366F1', fontSize: 16 },
  title:     { fontSize: 24, fontWeight: '700', color: '#F9FAFB', textAlign: 'center', marginBottom: 32 },
  input:     {
    backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 12,
    padding: 14, marginBottom: 12, fontSize: 16, borderWidth: 1, borderColor: '#374151',
  },
  btn:       { backgroundColor: '#6366F1', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnText:   { color: '#fff', fontWeight: '700', fontSize: 16 },
});
