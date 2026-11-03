import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function ScreenHeader({ title, right, left }) {
  return (
    <View style={s.header}>
      <View style={s.side}>{left || null}</View>
      <Text style={s.title}>{title}</Text>
      <View style={s.side}>{right || null}</View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: '#0F0F1A',
  },
  title: { color: '#F9FAFB', fontSize: 20, fontWeight: '700' },
  side:  { minWidth: 80 },
});
