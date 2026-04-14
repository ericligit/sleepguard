import {create} from 'zustand';
import type {RecordingState} from '../types';

interface RecordingStore extends RecordingState {
  // Partial setState is provided by zustand — no extra actions needed here;
  // the hook manages all mutations.
}

export const useRecordingStore = create<RecordingStore>(() => ({
  isRecording: false,
  sessionId: null,
  outputPath: null,
  elapsedSeconds: 0,
  currentAmplitude: 0,
  amplitudeHistory: [],
}));
