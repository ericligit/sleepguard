package com.sleepguard

import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

/**
 * React Native bridge for AudioRecordingService.
 *
 * Exposed to JS as NativeModules.AudioRecording with methods:
 *   startRecording(options)  → Promise<{ sessionId, outputPath }>
 *   stopRecording()          → Promise<void>
 *   isRecording()            → Promise<boolean>
 *   getSessionFiles()        → Promise<Array<{ name, path, size, createdAt }>>
 *   deleteSession(path)      → Promise<void>
 *   requestPermissions()     → Promise<boolean>
 *
 * Events emitted via DeviceEventEmitter:
 *   AudioAmplitude      { rms, normalised, elapsedSeconds, sessionId }
 *   AudioSessionDone    { sessionId, filePath, durationSeconds }
 *   AudioRecordingError { sessionId, message }
 */
class AudioRecordingModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AudioRecording"
        private val RECORDING_PERMISSIONS = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }.toTypedArray()
    }

    private var permissionCallback: Callback? = null
    private var permissionRequestCode = 0
    private var mediaPlayer: MediaPlayer? = null

    override fun getName() = NAME

    // -------------------------------------------------------------------------
    // JS-callable methods
    // -------------------------------------------------------------------------

    @ReactMethod
    fun startRecording(options: ReadableMap, promise: Promise) {
        if (!hasRecordPermission()) {
            promise.reject("PERMISSION_DENIED", "RECORD_AUDIO permission not granted")
            return
        }

        val sessionId  = options.getString("sessionId")
            ?: "session_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}"
        val outputPath = options.getString("outputPath")
            ?: defaultOutputPath(sessionId)
        val vadThreshold = if (options.hasKey("vadThreshold")) options.getInt("vadThreshold") else 300

        // Pass react context to service so it can emit events back to JS
        AudioRecordingServiceHolder.reactContext = reactContext

        val intent = Intent(reactContext, AudioRecordingService::class.java).apply {
            action = AudioRecordingService.ACTION_START
            putExtra(AudioRecordingService.EXTRA_SESSION_ID, sessionId)
            putExtra(AudioRecordingService.EXTRA_OUTPUT_PATH, outputPath)
            putExtra(AudioRecordingService.EXTRA_VAD_THRESHOLD, vadThreshold)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }

        promise.resolve(Arguments.createMap().apply {
            putString("sessionId", sessionId)
            putString("outputPath", outputPath)
        })
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        val intent = Intent(reactContext, AudioRecordingService::class.java).apply {
            action = AudioRecordingService.ACTION_STOP
        }
        reactContext.startService(intent)
        promise.resolve(null)
    }

    @ReactMethod
    fun isRecording(promise: Promise) {
        // AudioRecordingServiceHolder.isRunning is updated by the service
        promise.resolve(AudioRecordingServiceHolder.isRunning)
    }

    @ReactMethod
    fun getSessionFiles(promise: Promise) {
        val dir = File(reactContext.getExternalFilesDir(null), "recordings")
        val files = dir.listFiles { f -> f.extension == "wav" } ?: emptyArray()
        val result = Arguments.createArray()
        files.sortedByDescending { it.lastModified() }.forEach { f ->
            result.pushMap(Arguments.createMap().apply {
                putString("name", f.nameWithoutExtension)
                putString("path", f.absolutePath)
                putDouble("size", f.length().toDouble())
                putDouble("createdAt", f.lastModified().toDouble())
            })
        }
        promise.resolve(result)
    }

    @ReactMethod
    fun deleteSession(filePath: String, promise: Promise) {
        val file = File(filePath)
        if (file.exists()) file.delete()
        promise.resolve(null)
    }

    @ReactMethod
    fun requestPermissions(promise: Promise) {
        val missing = RECORDING_PERMISSIONS.filter {
            ContextCompat.checkSelfPermission(reactContext, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            promise.resolve(true)
            return
        }
        val activity = getCurrentActivity() as? PermissionAwareActivity ?: run {
            promise.reject("NO_ACTIVITY", "Activity not available")
            return
        }
        permissionRequestCode++
        val code = permissionRequestCode
        activity.requestPermissions(missing.toTypedArray(), code, object : PermissionListener {
            override fun onRequestPermissionsResult(
                requestCode: Int, permissions: Array<String>, results: IntArray
            ): Boolean {
                if (requestCode != code) return false
                val granted = results.all { it == PackageManager.PERMISSION_GRANTED }
                promise.resolve(granted)
                return true
            }
        })
    }

    // -------------------------------------------------------------------------
    // Playback
    // -------------------------------------------------------------------------

    @ReactMethod
    fun playRecording(filePath: String, promise: Promise) {
        try {
            // Resolve actual playable path: if .wav missing but .pcm exists, convert first
            val resolvedPath = resolvePlayablePath(filePath)
                ?: return promise.reject("FILE_NOT_FOUND", "Recording file not found: $filePath")

            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(resolvedPath)
                prepare()
                start()
                setOnCompletionListener {
                    AudioRecordingServiceHolder.reactContext
                        ?.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        ?.emit("AudioPlaybackDone", null)
                    release()
                    mediaPlayer = null
                }
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PLAYBACK_ERROR", e.message)
        }
    }

    /** Returns a playable WAV path, converting from PCM if needed. Returns null if no file found. */
    private fun resolvePlayablePath(wavPath: String): String? {
        val wavFile = File(wavPath)
        if (wavFile.exists()) return wavPath

        // Check for orphaned PCM file (service was killed before WAV conversion)
        val pcmFile = File(wavPath.replace(".wav", ".pcm"))
        if (pcmFile.exists() && pcmFile.length() > 0) {
            AudioRecordingService.pcmToWavStatic(pcmFile, wavFile)
            if (wavFile.exists()) {
                pcmFile.delete()
                return wavPath
            }
        }
        return null
    }

    @ReactMethod
    fun stopPlayback(promise: Promise) {
        mediaPlayer?.apply { if (isPlaying) stop(); release() }
        mediaPlayer = null
        promise.resolve(null)
    }

    @ReactMethod
    fun getPlaybackPosition(promise: Promise) {
        val player = mediaPlayer
        if (player != null && player.isPlaying) {
            promise.resolve(player.currentPosition / 1000.0)
        } else {
            promise.resolve(-1.0)
        }
    }

    // Required for DeviceEventEmitter — marks module as non-lazy
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private fun hasRecordPermission() =
        ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun defaultOutputPath(sessionId: String): String {
        val dir = File(reactContext.getExternalFilesDir(null), "recordings")
        dir.mkdirs()
        return "${dir.absolutePath}/$sessionId.wav"
    }
}

/** Singleton to share state between service and bridge module without binding. */
object AudioRecordingServiceHolder {
    @Volatile var isRunning: Boolean = false
    @Volatile var reactContext: ReactApplicationContext? = null
}
