package com.sleepguard

import android.app.*
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder.AudioSource
import android.os.*
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.*
import java.text.SimpleDateFormat
import java.util.*
import kotlin.math.sqrt

/**
 * Foreground service that records audio overnight using Android's AudioRecord API.
 *
 * Key design decisions:
 *  - Uses VOICE_RECOGNITION audio source for best raw pickup vs VOICE_COMMUNICATION
 *    (which applies AGC/noise suppression that would distort apnea sounds)
 *  - 16 kHz / 16-bit PCM is sufficient for respiratory sound analysis (0–4 kHz range)
 *  - Writes raw PCM in chunks; a separate thread finalises into WAV on stop
 *  - RMS-based VAD: only persists audio segments above silence threshold, saving disk
 *  - Emits amplitude events to JS layer every 100 ms for live waveform display
 */
class AudioRecordingService : Service() {

    companion object {
        const val ACTION_START  = "com.sleepguard.ACTION_START_RECORDING"
        const val ACTION_STOP   = "com.sleepguard.ACTION_STOP_RECORDING"

        const val EXTRA_SESSION_ID   = "SESSION_ID"
        const val EXTRA_OUTPUT_PATH  = "OUTPUT_PATH"
        const val EXTRA_VAD_THRESHOLD = "VAD_THRESHOLD"   // RMS 0–32767, default 300

        const val EVENT_AMPLITUDE    = "AudioAmplitude"
        const val EVENT_SESSION_DONE = "AudioSessionDone"
        const val EVENT_ERROR        = "AudioRecordingError"

        private const val TAG               = "AudioRecordingService"
        private const val NOTIF_CHANNEL_ID  = "sleep_recording"
        private const val NOTIF_ID          = 1001

        const val SAMPLE_RATE    = 16000          // Hz
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT   = AudioFormat.ENCODING_PCM_16BIT
        const val AMPLITUDE_INTERVAL_MS = 100L    // how often to emit RMS to JS

        /** Static entry point so AudioRecordingModule can convert orphaned PCM files. */
        fun pcmToWavStatic(pcmFile: java.io.File, wavFile: java.io.File) {
            if (!pcmFile.exists()) return
            val pcmSize = pcmFile.length()
            val byteRate = SAMPLE_RATE * 2  // mono * 16-bit
            try {
                java.io.DataOutputStream(java.io.BufferedOutputStream(java.io.FileOutputStream(wavFile))).use { out ->
                    fun writeIntLE(v: Int) { out.write(v and 0xFF); out.write((v shr 8) and 0xFF); out.write((v shr 16) and 0xFF); out.write((v shr 24) and 0xFF) }
                    fun writeShortLE(v: Int) { out.write(v and 0xFF); out.write((v shr 8) and 0xFF) }
                    out.writeBytes("RIFF"); writeIntLE((pcmSize + 36).toInt())
                    out.writeBytes("WAVE")
                    out.writeBytes("fmt "); writeIntLE(16); writeShortLE(1); writeShortLE(1)
                    writeIntLE(SAMPLE_RATE); writeIntLE(byteRate); writeShortLE(2); writeShortLE(16)
                    out.writeBytes("data"); writeIntLE(pcmSize.toInt())
                    pcmFile.inputStream().use { it.copyTo(out) }
                }
            } catch (e: Exception) {
                android.util.Log.e("AudioRecordingService", "Static PCM→WAV failed", e)
            }
        }
    }

    // -- State --
    private var audioRecord: AudioRecord? = null
    private var recordingThread: Thread? = null
    @Volatile private var isRecording = false

    private var sessionId: String = ""
    private var outputPath: String = ""
    private var vadThreshold: Int = 300           // default RMS silence threshold

    private val wakeLock: PowerManager.WakeLock by lazy {
        (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepGuard::RecordingWakeLock")
    }

    // Cached reference to React context for event emitting (nullable — service outlives activity)
    var reactContext: ReactApplicationContext? = null

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                sessionId    = intent.getStringExtra(EXTRA_SESSION_ID) ?: generateSessionId()
                outputPath   = intent.getStringExtra(EXTRA_OUTPUT_PATH) ?: defaultOutputPath()
                vadThreshold = intent.getIntExtra(EXTRA_VAD_THRESHOLD, 300)
                startRecording()
            }
            ACTION_STOP -> stopRecording()
        }
        return START_STICKY      // restart if killed, preserving wake-lock
    }

    override fun onDestroy() {
        stopRecording()
        super.onDestroy()
    }

    // -------------------------------------------------------------------------
    // Recording control
    // -------------------------------------------------------------------------

    private fun startRecording() {
        if (isRecording) return

        val bufferSize = maxOf(
            AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT),
            SAMPLE_RATE * 2   // at least 1 second of buffer
        )

        audioRecord = AudioRecord(
            AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize
        )

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            emitError("AudioRecord failed to initialise")
            stopSelf()
            return
        }

        isRecording = true
        wakeLock.acquire(10 * 60 * 60 * 1000L)   // up to 10 hours

        startForeground(NOTIF_ID, buildNotification())

        recordingThread = Thread({ recordLoop(bufferSize) }, "AudioRecorder").apply { start() }
        Log.i(TAG, "Recording started → $outputPath")
    }

    private fun stopRecording() {
        if (!isRecording) return
        isRecording = false
        recordingThread?.join(3000)
        audioRecord?.apply { stop(); release() }
        audioRecord = null
        if (wakeLock.isHeld) wakeLock.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Log.i(TAG, "Recording stopped")
    }

    // -------------------------------------------------------------------------
    // Core record loop — runs on a dedicated thread
    // -------------------------------------------------------------------------

    private fun recordLoop(bufferSize: Int) {
        val pcmBuffer = ShortArray(bufferSize / 2)
        val pcmFile   = File(outputPath.replace(".wav", ".pcm"))
        pcmFile.parentFile?.mkdirs()

        var lastAmplitudeEmit = System.currentTimeMillis()
        var totalFrames = 0L

        audioRecord?.startRecording()

        try {
            FileOutputStream(pcmFile).use { fos ->
                while (isRecording) {
                    val read = audioRecord?.read(pcmBuffer, 0, pcmBuffer.size) ?: -1
                    if (read <= 0) continue

                    totalFrames += read

                    val rms = computeRms(pcmBuffer, read)

                    // VAD: only write frames above silence threshold
                    if (rms >= vadThreshold) {
                        val byteBuffer = ByteArray(read * 2)
                        for (i in 0 until read) {
                            byteBuffer[i * 2]     = (pcmBuffer[i].toInt() and 0xFF).toByte()
                            byteBuffer[i * 2 + 1] = ((pcmBuffer[i].toInt() shr 8) and 0xFF).toByte()
                        }
                        fos.write(byteBuffer)
                    }

                    // Emit amplitude update to JS at ~10 Hz
                    val now = System.currentTimeMillis()
                    if (now - lastAmplitudeEmit >= AMPLITUDE_INTERVAL_MS) {
                        emitAmplitude(rms, totalFrames)
                        lastAmplitudeEmit = now
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Recording loop error", e)
            emitError(e.message ?: "Unknown recording error")
        } finally {
            audioRecord?.stop()
            // Convert PCM → WAV
            pcmToWav(pcmFile, File(outputPath))
            pcmFile.delete()
            emitSessionDone(outputPath, totalFrames)
        }
    }

    // -------------------------------------------------------------------------
    // PCM → WAV conversion (writes standard 44-byte WAV header)
    // -------------------------------------------------------------------------

    private fun pcmToWav(pcmFile: File, wavFile: File) {
        if (!pcmFile.exists()) return
        val pcmSize = pcmFile.length()
        val channels = 1
        val bitsPerSample = 16
        val byteRate = SAMPLE_RATE * channels * bitsPerSample / 8

        try {
            DataOutputStream(BufferedOutputStream(FileOutputStream(wavFile))).use { out ->
                // RIFF header
                out.writeBytes("RIFF")
                out.writeIntLE((pcmSize + 36).toInt())
                out.writeBytes("WAVE")
                // fmt  chunk
                out.writeBytes("fmt ")
                out.writeIntLE(16)           // chunk size
                out.writeShortLE(1)          // PCM format
                out.writeShortLE(channels)
                out.writeIntLE(SAMPLE_RATE)
                out.writeIntLE(byteRate)
                out.writeShortLE((channels * bitsPerSample / 8))
                out.writeShortLE(bitsPerSample)
                // data chunk
                out.writeBytes("data")
                out.writeIntLE(pcmSize.toInt())
                // PCM payload
                pcmFile.inputStream().use { it.copyTo(out) }
            }
            Log.i(TAG, "WAV written: ${wavFile.path} (${wavFile.length()} bytes)")
        } catch (e: Exception) {
            Log.e(TAG, "PCM→WAV conversion failed", e)
        }
    }

    // Little-endian write helpers missing from DataOutputStream
    private fun DataOutputStream.writeIntLE(v: Int) {
        write(v and 0xFF); write((v shr 8) and 0xFF)
        write((v shr 16) and 0xFF); write((v shr 24) and 0xFF)
    }
    private fun DataOutputStream.writeShortLE(v: Int) {
        write(v and 0xFF); write((v shr 8) and 0xFF)
    }

    // -------------------------------------------------------------------------
    // DSP helpers
    // -------------------------------------------------------------------------

    private fun computeRms(buffer: ShortArray, count: Int): Int {
        var sum = 0.0
        for (i in 0 until count) sum += (buffer[i] * buffer[i]).toDouble()
        return sqrt(sum / count).toInt()
    }

    // -------------------------------------------------------------------------
    // React Native event emission
    // -------------------------------------------------------------------------

    private fun emitAmplitude(rms: Int, totalFrames: Long) {
        AudioRecordingServiceHolder.reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(EVENT_AMPLITUDE, Arguments.createMap().apply {
                putInt("rms", rms)
                putDouble("normalised", (rms.toDouble() / 32767.0).coerceIn(0.0, 1.0))
                putDouble("elapsedSeconds", totalFrames.toDouble() / SAMPLE_RATE)
                putString("sessionId", sessionId)
            })
    }

    private fun emitSessionDone(path: String, frames: Long) {
        AudioRecordingServiceHolder.reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(EVENT_SESSION_DONE, Arguments.createMap().apply {
                putString("sessionId", sessionId)
                putString("filePath", path)
                putDouble("durationSeconds", frames.toDouble() / SAMPLE_RATE)
            })
    }

    private fun emitError(message: String) {
        AudioRecordingServiceHolder.reactContext?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(EVENT_ERROR, Arguments.createMap().apply {
                putString("sessionId", sessionId)
                putString("message", message)
            })
    }

    // -------------------------------------------------------------------------
    // Notification
    // -------------------------------------------------------------------------

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "Sleep Recording",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active while SleepGuard records audio"
                setSound(null, null)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val stopIntent = Intent(this, AudioRecordingService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPi = PendingIntent.getService(
            this, 0, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openAppPi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("SleepGuard — Recording")
            .setContentText("Monitoring your sleep audio…")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openAppPi)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPi)
            .build()
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun generateSessionId() =
        "session_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}"

    private fun defaultOutputPath(): String {
        val dir = File(getExternalFilesDir(null), "recordings")
        dir.mkdirs()
        return "${dir.absolutePath}/$sessionId.wav"
    }
}
