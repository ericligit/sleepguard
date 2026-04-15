/**
 * SessionDetailScreen — shows a single sleep session's results with audio playback.
 */

import React, {useEffect, useState, useCallback} from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Alert,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import {format, formatDuration, intervalToDuration} from 'date-fns';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RouteProp} from '@react-navigation/native';
import {getSession, deleteSession} from '../services/database';
import {analyzeAndPersist} from '../services/apneaAnalysis';
import type {SleepSession, RootStackParamList} from '../types';

const {AudioRecording} = NativeModules;
const playbackEmitter = AudioRecording
  ? new NativeEventEmitter(AudioRecording)
  : {addListener: () => ({remove: () => {}})} as any;

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'SessionDetail'>;
  route: RouteProp<RootStackParamList, 'SessionDetail'>;
};

function durationLabel(seconds: number): string {
  if (seconds <= 0) return '—';
  return formatDuration(intervalToDuration({start: 0, end: seconds * 1000}), {
    format: ['hours', 'minutes', 'seconds'],
  });
}

interface StatRowProps {
  label: string;
  value: string;
  valueColor?: string;
}
const StatRow: React.FC<StatRowProps> = ({label, value, valueColor}) => (
  <View style={styles.statRow}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[styles.statValue, valueColor ? {color: valueColor} : null]}>
      {value}
    </Text>
  </View>
);

export const SessionDetailScreen: React.FC<Props> = ({navigation, route}) => {
  const {sessionId} = route.params;
  const [session, setSession] = useState<SleepSession | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    getSession(sessionId).then(setSession);
  }, [sessionId]);

  useEffect(() => {
    const sub = playbackEmitter.addListener('AudioPlaybackDone', () => {
      setIsPlaying(false);
    });
    return () => sub.remove();
  }, []);

  // Stop playback when leaving the screen
  useEffect(() => {
    return () => {
      if (isPlaying) AudioRecording?.stopPlayback?.();
    };
  }, [isPlaying]);

  const handlePlayStop = useCallback(async () => {
    if (!session?.filePath) return;
    try {
      if (isPlaying) {
        await AudioRecording.stopPlayback();
        setIsPlaying(false);
      } else {
        await AudioRecording.playRecording(session.filePath);
        setIsPlaying(true);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Playback Error', msg);
    }
  }, [isPlaying, session]);

  const handleAnalyze = useCallback(async () => {
    if (!session?.filePath) return;
    setIsAnalyzing(true);
    try {
      const result = await analyzeAndPersist(session.id, session.filePath);
      // Refresh session from DB so stats update
      const updated = await getSession(session.id);
      if (updated) setSession(updated);
      Alert.alert(
        'Analysis Complete',
        `AHI: ${result.ahi.toFixed(1)}  |  ${result.apneaCount} apneas, ${result.hypopneaCount} hypopneas`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('Analysis Error', msg);
    } finally {
      setIsAnalyzing(false);
    }
  }, [session]);

  const handleDelete = () => {
    Alert.alert('Delete Session', 'This will permanently delete the recording and data.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (isPlaying) await AudioRecording?.stopPlayback?.();
          if (session) await deleteSession(session.id);
          navigation.goBack();
        },
      },
    ]);
  };

  if (!session) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.loading}>Loading…</Text>
      </SafeAreaView>
    );
  }

  const startLabel = format(session.startedAt, 'EEE MMM d, yyyy · h:mm a');
  const ahiColor =
    !session.ahi ? '#9E9E9E'
    : session.ahi < 5  ? '#66BB6A'
    : session.ahi < 15 ? '#FFA726'
    : session.ahi < 30 ? '#EF5350'
    : '#B71C1C';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Date header */}
        <Text style={styles.sessionDate}>{startLabel}</Text>

        {/* Playback */}
        <TouchableOpacity
          style={[styles.playBtn, isPlaying && styles.playBtnActive]}
          onPress={handlePlayStop}
          activeOpacity={0.8}>
          <Text style={styles.playBtnIcon}>{isPlaying ? '⏹' : '▶'}</Text>
          <Text style={styles.playBtnText}>
            {isPlaying ? 'Stop Playback' : 'Play Recording'}
          </Text>
        </TouchableOpacity>

        {/* Analyze */}
        <TouchableOpacity
          style={[styles.analyzeBtn, isAnalyzing && styles.analyzeBtnDisabled]}
          onPress={handleAnalyze}
          disabled={isAnalyzing}
          activeOpacity={0.8}>
          <Text style={styles.analyzeBtnText}>
            {isAnalyzing ? 'Analyzing…' : 'Run AI Analysis'}
          </Text>
        </TouchableOpacity>

        {/* AHI hero */}
        <View style={styles.ahiCard}>
          <Text style={[styles.ahiBig, {color: ahiColor}]}>
            {session.ahi != null ? session.ahi.toFixed(1) : '—'}
          </Text>
          <Text style={styles.ahiUnit}>Apnea-Hypopnea Index (events/hr)</Text>
          {session.severity && (
            <Text style={[styles.severityLabel, {color: ahiColor}]}>
              {session.severity.toUpperCase()} OSA
            </Text>
          )}
          {!session.ahi && (
            <Text style={styles.pendingText}>
              AI analysis pending — available after Phase 2 model
            </Text>
          )}
        </View>

        {/* Stats */}
        <View style={styles.statsCard}>
          <StatRow label="Duration" value={durationLabel(session.durationSeconds)} />
          <StatRow label="Apnea events" value={String(session.apneaCount)} />
          <StatRow label="Hypopnea events" value={String(session.hypopneaCount)} />
          <StatRow
            label="Longest apnea"
            value={session.longestApneaSec > 0 ? `${session.longestApneaSec.toFixed(0)} s` : '—'}
          />
        </View>

        {/* SpO2 */}
        <View style={styles.statsCard}>
          <Text style={styles.cardTitle}>Blood Oxygen (SpO₂)</Text>
          <StatRow
            label="Average"
            value={session.spo2Avg != null ? `${session.spo2Avg.toFixed(0)}%` : '—'}
          />
          <StatRow
            label="Minimum"
            value={session.spo2Min != null ? `${session.spo2Min.toFixed(0)}%` : '—'}
            valueColor={session.spo2Min != null && session.spo2Min < 90 ? '#EF5350' : undefined}
          />
          {!session.spo2Avg && (
            <Text style={styles.pendingText}>
              Connect a wearable via Health Connect to see SpO₂ data.
            </Text>
          )}
        </View>

        {/* Delete */}
        <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
          <Text style={styles.deleteBtnText}>Delete Session</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: '#0D1B2A'},
  loading: {color: '#9E9E9E', textAlign: 'center', marginTop: 40},
  scroll: {padding: 20, gap: 16},

  sessionDate: {color: '#90A4AE', fontSize: 13},

  playBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1565C0',
    borderRadius: 14,
    paddingVertical: 16,
    gap: 10,
  },
  playBtnActive: {backgroundColor: '#37474F'},
  playBtnIcon: {fontSize: 20},
  playBtnText: {color: '#FFFFFF', fontSize: 16, fontWeight: '700'},

  ahiCard: {
    backgroundColor: '#122040',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 6,
  },
  ahiBig: {fontSize: 64, fontWeight: '200', lineHeight: 72},
  ahiUnit: {color: '#607D8B', fontSize: 12, textAlign: 'center'},
  severityLabel: {fontSize: 16, fontWeight: '700', letterSpacing: 1},
  pendingText: {color: '#455A64', fontSize: 12, textAlign: 'center', marginTop: 4},

  statsCard: {
    backgroundColor: '#122040',
    borderRadius: 16,
    padding: 16,
    gap: 2,
  },
  cardTitle: {color: '#90A4AE', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8},
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1A2744',
  },
  statLabel: {color: '#90A4AE', fontSize: 14},
  statValue: {color: '#E0E0E0', fontSize: 14, fontWeight: '600'},

  analyzeBtn: {
    backgroundColor: '#1B5E20',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  analyzeBtnDisabled: {backgroundColor: '#2E3B2E', opacity: 0.6},
  analyzeBtnText: {color: '#A5D6A7', fontSize: 16, fontWeight: '700'},

  deleteBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#EF535033',
  },
  deleteBtnText: {color: '#EF5350', fontSize: 15, fontWeight: '600'},
});
