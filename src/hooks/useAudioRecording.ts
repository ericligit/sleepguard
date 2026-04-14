/**
 * useAudioRecording — React hook that bridges the native AudioRecording module.
 *
 * Manages permission requests, start/stop lifecycle, and subscribes to
 * DeviceEventEmitter events for live amplitude updates.
 */

import {useEffect, useRef, useCallback} from 'react';
import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {useRecordingStore} from '../store/recordingStore';
import {insertSession, updateSession} from '../services/database';
import type {SleepSession} from '../types';

const {AudioRecording} = NativeModules;
// Guard: NativeEventEmitter throws if the module is null (e.g. on first install
// before the native module is linked). Fall back to DeviceEventEmitter.
const emitter = AudioRecording
  ? new NativeEventEmitter(AudioRecording)
  : {addListener: () => ({remove: () => {}})} as any;

const AMPLITUDE_HISTORY_SIZE = 120; // ~12 seconds at 10 Hz

export function useAudioRecording() {
  const store = useRecordingStore();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Subscribe to native events ───────────────────────────────────────────

  useEffect(() => {
    const ampSub = emitter.addListener(
      'AudioAmplitude',
      ({normalised, elapsedSeconds}: {normalised: number; elapsedSeconds: number}) => {
        useRecordingStore.setState(prev => {
          const history = [...prev.amplitudeHistory, normalised].slice(
            -AMPLITUDE_HISTORY_SIZE,
          );
          return {
            currentAmplitude: normalised,
            elapsedSeconds,
            amplitudeHistory: history,
          };
        });
      },
    );

    const doneSub = emitter.addListener(
      'AudioSessionDone',
      async ({sessionId, filePath, durationSeconds}: {
        sessionId: string;
        filePath: string;
        durationSeconds: number;
      }) => {
        const endedAt = Date.now();
        await updateSession(sessionId, {
          endedAt,
          durationSeconds,
          filePath,
        });
        useRecordingStore.setState({
          isRecording: false,
          sessionId: null,
          outputPath: null,
          elapsedSeconds: 0,
          currentAmplitude: 0,
          amplitudeHistory: [],
        });
      },
    );

    const errSub = emitter.addListener(
      'AudioRecordingError',
      ({message}: {message: string}) => {
        console.error('[AudioRecording]', message);
        useRecordingStore.setState({isRecording: false});
      },
    );

    return () => {
      ampSub.remove();
      doneSub.remove();
      errSub.remove();
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return false;
    return AudioRecording.requestPermissions();
  }, []);

  const startRecording = useCallback(async () => {
    const granted = await requestPermissions();
    if (!granted) {
      throw new Error('Microphone permission denied');
    }

    const startedAt = Date.now();
    const {sessionId, outputPath} = await AudioRecording.startRecording({
      vadThreshold: 250,
    });

    // Persist session row immediately so we can track partial sessions
    const session: SleepSession = {
      id: sessionId,
      startedAt,
      endedAt: null,
      durationSeconds: 0,
      filePath: outputPath,
      fileSizeBytes: 0,
      ahi: null,
      severity: null,
      apneaCount: 0,
      hypopneaCount: 0,
      longestApneaSec: 0,
      spo2Min: null,
      spo2Avg: null,
      notes: '',
    };
    await insertSession(session);

    useRecordingStore.setState({
      isRecording: true,
      sessionId,
      outputPath,
      elapsedSeconds: 0,
      amplitudeHistory: [],
    });
  }, [requestPermissions]);

  const stopRecording = useCallback(async () => {
    await AudioRecording.stopRecording();
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    ...store,
    startRecording,
    stopRecording,
    requestPermissions,
  };
}
