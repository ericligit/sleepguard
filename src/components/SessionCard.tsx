import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import {format} from 'date-fns';
import type {SleepSession, ApneaSeverity} from '../types';

const SEVERITY_COLOR: Record<ApneaSeverity, string> = {
  normal:   '#66BB6A',
  mild:     '#FFA726',
  moderate: '#EF5350',
  severe:   '#B71C1C',
};

interface Props {
  session: SleepSession;
  onPress: () => void;
}

export const SessionCard: React.FC<Props> = ({session, onPress}) => {
  const date = format(session.startedAt, 'EEE, MMM d yyyy');
  const time = format(session.startedAt, 'h:mm a');
  const hours = (session.durationSeconds / 3600).toFixed(1);
  const severityColor =
    session.severity ? SEVERITY_COLOR[session.severity] : '#9E9E9E';
  const ahiLabel =
    session.ahi != null ? session.ahi.toFixed(1) : '—';

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.left}>
        <Text style={styles.date}>{date}</Text>
        <Text style={styles.time}>{time} · {hours} hrs</Text>
        {session.spo2Avg != null && (
          <Text style={styles.spo2}>SpO₂ avg {session.spo2Avg.toFixed(0)}%</Text>
        )}
      </View>
      <View style={styles.right}>
        <Text style={[styles.ahi, {color: severityColor}]}>{ahiLabel}</Text>
        <Text style={styles.ahiLabel}>AHI</Text>
        {session.severity && (
          <View style={[styles.badge, {backgroundColor: severityColor + '33'}]}>
            <Text style={[styles.badgeText, {color: severityColor}]}>
              {session.severity.toUpperCase()}
            </Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: '#1A2744',
    borderRadius: 12,
    padding: 16,
    marginVertical: 6,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {flex: 1},
  right: {alignItems: 'flex-end', minWidth: 72},
  date: {color: '#E0E0E0', fontSize: 15, fontWeight: '600'},
  time: {color: '#9E9E9E', fontSize: 13, marginTop: 2},
  spo2: {color: '#81D4FA', fontSize: 12, marginTop: 4},
  ahi: {fontSize: 26, fontWeight: '700'},
  ahiLabel: {color: '#9E9E9E', fontSize: 11, letterSpacing: 1},
  badge: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  badgeText: {fontSize: 10, fontWeight: '700', letterSpacing: 0.5},
});
