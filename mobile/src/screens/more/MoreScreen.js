import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSelector } from 'react-redux';
import ScreenHeader from '../../components/ScreenHeader';

const FEATURES = [
  { icon: '✅', label: 'משימות',       screen: 'Tasks',          color: '#6366F1' },
  { icon: '👥', label: 'לקוחות',       screen: 'Customers',      color: '#10B981' },
  { icon: '📊', label: 'דוח שבועי',    screen: 'WeeklyReports',  color: '#8B5CF6' },
  { icon: '⭐', label: 'ביקורות',      screen: 'Reviews',        color: '#F59E0B' },
  { icon: '🔢', label: 'תור / המתנה',  screen: 'Queue',          color: '#EF4444' },
  { icon: '🍽️', label: 'הנדסת תפריט',  screen: 'MenuEngineering', color: '#06B6D4' },
  { icon: '🏷️', label: 'השוואת מחירים', screen: 'PriceComparison', color: '#EC4899' },
  { icon: '🖼️', label: 'גלריה',        screen: 'Gallery',        color: '#84CC16' },
  { icon: '💵', label: 'שכר ותלושים',  screen: 'Payroll',        color: '#F97316' },
  { icon: '🏪', label: 'דוחות / מכירות',   screen: 'ZReports',  color: '#14B8A6' },
];

export default function MoreScreen({ navigation }) {
  const { user } = useSelector(s => s.auth);

  return (
    <View style={s.container}>
      <ScreenHeader title="עוד פיצ'רים" />
      <ScrollView contentContainerStyle={s.grid}>
        {FEATURES.map(f => (
          <TouchableOpacity
            key={f.screen}
            style={[s.card, { borderTopColor: f.color }]}
            onPress={() => navigation.navigate(f.screen)}
          >
            <Text style={s.icon}>{f.icon}</Text>
            <Text style={s.label}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  grid:      { flexDirection: 'row', flexWrap: 'wrap', padding: 12, gap: 12 },
  card:      {
    width: '46%', backgroundColor: '#1E1E2E', borderRadius: 16,
    padding: 20, alignItems: 'center', borderTopWidth: 3,
  },
  icon:  { fontSize: 36, marginBottom: 10 },
  label: { color: '#F9FAFB', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
