import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';

export default function AlertBanner({ title, onPress }) {
  return (
    <TouchableOpacity style={s.banner} onPress={onPress}>
      <Text style={s.text}>{title}</Text>
      <Text style={s.arrow}>←</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  banner: {
    backgroundColor: '#7C2D12',
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  text:  { color: '#FEF2F2', fontSize: 14, fontWeight: '600' },
  arrow: { color: '#FCA5A5', fontSize: 18 },
});
