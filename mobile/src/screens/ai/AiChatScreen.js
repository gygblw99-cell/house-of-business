import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import api from '../../services/api';

export default function AiChatScreen() {
  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    // טעינת היסטוריה
    api.getAiHistory().then(hist => {
      setMessages(hist.map(h => ({ role: h.role, content: h.content, id: h.id })));
    }).catch(() => {});

    // ניטור חיבור
    const unsub = NetInfo.addEventListener(state => {
      setIsOffline(!state.isConnected);
    });
    return () => unsub();
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    if (userMsg.length > 2000) {
      Alert.alert('הודעה ארוכה מדי', 'אנא קצר את ההודעה ל-2,000 תווים לכל היותר');
      return;
    }
    setInput('');

    const tempId = Date.now();
    setMessages(prev => [...prev, { role: 'user', content: userMsg, id: tempId }]);

    setLoading(true);
    try {
      const res = await api.aiChat(userMsg, isOffline);
      setMessages(prev => [...prev, {
        role:    'assistant',
        content: res.content,
        sources: res.sources,
        id:      tempId + 1,
      }]);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err) {
      Alert.alert('שגיאה', err.message);
    } finally { setLoading(false); }
  };

  const clearHistory = () => {
    Alert.alert('מחיקת שיחה', 'האם למחוק את כל היסטוריית השיחה?', [
      { text: 'ביטול', style: 'cancel' },
      {
        text: 'מחק',
        style: 'destructive',
        onPress: async () => {
          await api.clearAiHistory();
          setMessages([]);
        },
      },
    ]);
  };

  const SUGGESTIONS = ['מה המנות הכי רווחיות שלי?', 'איך אני יכול לצמצם בזבוז?', 'מה המגמה בהכנסות החודש?'];

  const renderMessage = ({ item }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAssistant]}>
        <Text style={[s.bubbleText, isUser ? s.bubbleTextUser : s.bubbleTextAssistant]}>
          {item.content}
        </Text>
        {item.sources?.length > 0 && (
          <View style={s.sources}>
            <Text style={s.sourcesLabel}>מקורות:</Text>
            {item.sources.map((src, i) => (
              <Text key={i} style={s.sourceLink} numberOfLines={1}>{src.title}</Text>
            ))}
          </View>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={80}
    >
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={clearHistory}>
          <Text style={s.clearBtn}>מחק שיחה</Text>
        </TouchableOpacity>
        <Text style={s.title}>יועץ AI</Text>
        {isOffline && <Text style={s.offlineBadge}>Offline</Text>}
      </View>

      {/* הודעת Offline */}
      {isOffline && (
        <View style={s.offlineBanner}>
          <Text style={s.offlineBannerText}>אין חיבור לאינטרנט — גישה לנתונים בלבד</Text>
        </View>
      )}

      {/* הודעות */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => String(m.id)}
        renderItem={renderMessage}
        contentContainerStyle={s.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>שלום! אני היועץ העסקי שלך 👋</Text>
            <Text style={s.emptySubtitle}>שאל אותי כל שאלה על העסק</Text>
            {SUGGESTIONS.map((s_, i) => (
              <TouchableOpacity key={i} style={s.suggestion} onPress={() => setInput(s_)}>
                <Text style={s.suggestionText}>{s_}</Text>
              </TouchableOpacity>
            ))}
          </View>
        }
      />

      {/* Input */}
      <View style={s.inputRow}>
        <TouchableOpacity
          style={[s.sendBtn, (!input.trim() || loading) && s.sendBtnDisabled]}
          onPress={sendMessage}
          disabled={!input.trim() || loading}
        >
          {loading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.sendIcon}>↑</Text>}
        </TouchableOpacity>
        <TextInput
          style={s.input}
          value={input}
          onChangeText={setInput}
          placeholder="שאל אותי..."
          placeholderTextColor="#6B7280"
          multiline
          maxLength={500}
          textAlign="right"
          onSubmitEditing={sendMessage}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container:           { flex: 1, backgroundColor: '#0F0F1A' },
  header:              { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56 },
  title:               { color: '#F9FAFB', fontSize: 18, fontWeight: '700' },
  clearBtn:            { color: '#6B7280', fontSize: 13 },
  offlineBadge:        { backgroundColor: '#374151', color: '#9CA3AF', fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  offlineBanner:       { backgroundColor: '#1F2937', paddingVertical: 8, paddingHorizontal: 16 },
  offlineBannerText:   { color: '#9CA3AF', fontSize: 12, textAlign: 'center' },
  messageList:         { padding: 16, gap: 12 },
  bubble:              { maxWidth: '85%', borderRadius: 18, padding: 14 },
  bubbleUser:          { alignSelf: 'flex-end', backgroundColor: '#6366F1' },
  bubbleAssistant:     { alignSelf: 'flex-start', backgroundColor: '#1E1E2E' },
  bubbleText:          { fontSize: 15, lineHeight: 22 },
  bubbleTextUser:      { color: '#fff' },
  bubbleTextAssistant: { color: '#F9FAFB' },
  sources:             { marginTop: 8, borderTopWidth: 1, borderTopColor: '#374151', paddingTop: 8 },
  sourcesLabel:        { color: '#6B7280', fontSize: 11, marginBottom: 4 },
  sourceLink:          { color: '#60A5FA', fontSize: 11, marginBottom: 2 },
  empty:               { flex: 1, alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 },
  emptyTitle:          { color: '#F9FAFB', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  emptySubtitle:       { color: '#9CA3AF', fontSize: 15, textAlign: 'center', marginBottom: 24 },
  suggestion:          { backgroundColor: '#1E1E2E', borderRadius: 12, padding: 14, marginBottom: 8, width: '100%' },
  suggestionText:      { color: '#D1D5DB', fontSize: 14, textAlign: 'right' },
  inputRow:            { flexDirection: 'row', padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: '#1E1E2E', alignItems: 'flex-end' },
  input:               { flex: 1, backgroundColor: '#1E1E2E', color: '#F9FAFB', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, maxHeight: 120 },
  sendBtn:             { backgroundColor: '#6366F1', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled:     { opacity: 0.4 },
  sendIcon:            { color: '#fff', fontSize: 20, fontWeight: '700' },
});
