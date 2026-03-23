import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { formatGhostPercent, ghostColor } from '@devghost/shared';
import type { GhostMetric } from '@devghost/shared';

interface OrderDashboardScreenProps {
  orderName: string;
  metrics: GhostMetric[];
}

export function OrderDashboardScreen({ orderName, metrics }: OrderDashboardScreenProps) {
  const active = metrics.filter(m => m.hasEnoughData);
  const avgGhost = active.length > 0
    ? active.reduce((s, m) => s + m.ghostPercent, 0) / active.length
    : null;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>{orderName}</Text>
      <View style={styles.kpiRow}>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Avg Ghost %</Text>
          <Text style={styles.kpiValue}>{formatGhostPercent(avgGhost)}</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>Developers</Text>
          <Text style={styles.kpiValue}>{metrics.length}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 16 },
  kpiRow: { flexDirection: 'row', gap: 12 },
  kpiCard: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 16,
  },
  kpiLabel: { fontSize: 12, color: '#888' },
  kpiValue: { fontSize: 24, fontWeight: 'bold', marginTop: 4 },
});
