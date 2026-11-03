import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function StatCard({ label, value, sub, color = '#6366F1' }) {
  return (
    <View style={[s.card, { borderLeftColor: color }]}>
      <Text style={s.value}>{value}</Text>
      <Text style={s.label}>{label}</Text>
      {sub ? <Text style={[s.sub, { color }]}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#1E1E2E',
    borderRadius: 14,
    padding: 14,
    flex: 1,
    minWidth: '45%',
    borderLeftWidth: 3,
  },
  value: { color: '#F9FAFB', fontSize: 22, fontWeight: '700', textAlign: 'right' },
  label: { color: '#9CA3AF', fontSize: 12, textAlign: 'right', marginTop: 4 },
  sub:   { fontSize: 11, textAlign: 'right', marginTop: 4, fontWeight: '600' },
});
