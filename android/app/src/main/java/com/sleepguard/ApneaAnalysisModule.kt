package com.sleepguard

import android.util.Log
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileInputStream
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel
import kotlin.math.*

/**
 * ApneaAnalysisModule — React Native bridge for on-device apnea event detection.
 *
 * Exposed to JS as NativeModules.ApneaAnalysis:
 *   analyzeSession(filePath, options) → Promise<AnalysisResult>
 *   getModelInfo()                   → Promise<{ version, inputShape, labels }>
 *
 * Pipeline per call:
 *   1. Load WAV → PCM samples
 *   2. Slide a 2-second window (stride 1 s) over the recording
 *   3. Compute log-mel spectrogram for each window (64 bins × 32 frames)
 *   4. Run TFLite inference → softmax probabilities for 5 classes
 *   5. Detect apnea events: cessation window followed within 60 s by gasp/recovery
 *   6. Compute AHI = (apnea events + hypopnea events) / duration_hours
 *   7. Return structured result to JS
 */
class ApneaAnalysisModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "ApneaAnalysis"
        private const val TAG = "ApneaAnalysis"

        // Must match Python training config
        const val SR             = 16000
        const val CLIP_SECS      = 2.0f
        const val N_MELS         = 64
        const val N_FRAMES       = 32
        const val HOP_LENGTH     = (SR * CLIP_SECS / N_FRAMES).toInt()   // 1000
        const val N_FFT          = 1024
        const val FMIN           = 50.0f
        const val FMAX           = 4000.0f

        const val MODEL_ASSET    = "apnea_model.tflite"
        const val STRIDE_SECS    = 1.0f   // window stride

        // Class indices — must match label_map.json
        const val CLS_SILENCE    = 0
        const val CLS_SNORING    = 1
        const val CLS_CESSATION  = 2
        const val CLS_GASP       = 3
        const val CLS_RECOVERY   = 4
        val CLASS_NAMES          = arrayOf("silence", "snoring", "cessation", "gasp", "recovery")

        // Event detection thresholds
        const val CONFIDENCE_MIN        = 0.60f   // min softmax score to accept a class
        const val CESSATION_MIN_SECS    = 8.0f    // apnea: cessation must last ≥ 8 s
        const val HYPOPNEA_MIN_SECS     = 5.0f    // hypopnea: partial cessation ≥ 5 s
        const val RECOVERY_WINDOW_SECS  = 60.0f   // gasp/recovery must follow within 60 s
    }

    // Lazy-load TFLite interpreter on first use
    private val interpreter: org.tensorflow.lite.Interpreter by lazy { loadInterpreter() }

    override fun getName() = NAME

    // -------------------------------------------------------------------------
    // JS-callable methods
    // -------------------------------------------------------------------------

    @ReactMethod
    fun analyzeSession(filePath: String, options: ReadableMap, promise: Promise) {
        Thread {
            try {
                val result = runAnalysis(filePath, options)
                promise.resolve(result)
            } catch (e: Exception) {
                Log.e(TAG, "Analysis failed", e)
                promise.reject("ANALYSIS_ERROR", e.message ?: "Unknown error")
            }
        }.start()
    }

    @ReactMethod
    fun getModelInfo(promise: Promise) {
        try {
            val interp = interpreter
            val inputShape = interp.getInputTensor(0).shape()   // [1, 64, 32, 1]
            promise.resolve(Arguments.createMap().apply {
                putString("version", "1.0-synthetic")
                putString("model", MODEL_ASSET)
                putArray("inputShape", Arguments.createArray().apply {
                    inputShape.forEach { pushInt(it) }
                })
                putArray("labels", Arguments.createArray().apply {
                    CLASS_NAMES.forEach { pushString(it) }
                })
            })
        } catch (e: Exception) {
            promise.reject("MODEL_ERROR", e.message)
        }
    }

    // Required for DeviceEventEmitter
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // -------------------------------------------------------------------------
    // Core analysis pipeline
    // -------------------------------------------------------------------------

    private fun runAnalysis(filePath: String, options: ReadableMap): WritableMap {
        val confThreshold = if (options.hasKey("confidenceThreshold"))
            options.getDouble("confidenceThreshold").toFloat() else CONFIDENCE_MIN

        // 1. Load WAV
        val samples = loadWavSamples(filePath)
        val durationSecs = samples.size.toFloat() / SR
        Log.i(TAG, "Loaded ${samples.size} samples (${durationSecs}s) from $filePath")

        // 2. Slide windows and classify
        val strideLen = (STRIDE_SECS * SR).toInt()
        val windowLen = (CLIP_SECS * SR).toInt()
        val windowResults = mutableListOf<Pair<Float, Int>>()   // (offsetSec, classIdx)

        var offset = 0
        while (offset + windowLen <= samples.size) {
            val window = samples.copyOfRange(offset, offset + windowLen)
            val mel    = computeLogMel(window)
            val probs  = runInference(mel)
            val bestCls = probs.indices.maxByOrNull { probs[it] }!!
            val bestConf = probs[bestCls]
            val cls = if (bestConf >= confThreshold) bestCls else CLS_SILENCE
            windowResults.add(Pair(offset.toFloat() / SR, cls))
            offset += strideLen
        }

        // 3. Detect apnea and hypopnea events from window sequence
        val events = detectEvents(windowResults)

        val apneaEvents    = events.count { it.type == "apnea" }
        val hypopneaEvents = events.count { it.type == "hypopnea" }
        val snoringEvents  = events.count { it.type == "snoring" }

        val durationHours = durationSecs / 3600f
        val ahi = if (durationHours > 0)
            (apneaEvents + hypopneaEvents).toFloat() / durationHours else 0f

        val severity = when {
            ahi < 5  -> "none"
            ahi < 15 -> "mild"
            ahi < 30 -> "moderate"
            else     -> "severe"
        }

        // 4. Build result map
        return Arguments.createMap().apply {
            putDouble("ahi", ahi.toDouble())
            putString("severity", severity)
            putInt("apneaCount", apneaEvents)
            putInt("hypopneaCount", hypopneaEvents)
            putDouble("durationSeconds", durationSecs.toDouble())

            val longestApnea = events.filter { it.type == "apnea" }
                .maxOfOrNull { it.durationSec } ?: 0f
            putDouble("longestApneaSec", longestApnea.toDouble())

            // Detailed event list
            val eventsArray = Arguments.createArray()
            events.forEach { ev ->
                eventsArray.pushMap(Arguments.createMap().apply {
                    putString("type", ev.type)
                    putDouble("startOffsetSec", ev.startSec.toDouble())
                    putDouble("durationSec", ev.durationSec.toDouble())
                    putDouble("confidence", ev.confidence.toDouble())
                })
            }
            putArray("events", eventsArray)

            // Window-level classifications for waveform overlay
            val classArray = Arguments.createArray()
            windowResults.forEach { (t, cls) ->
                classArray.pushMap(Arguments.createMap().apply {
                    putDouble("t", t.toDouble())
                    putInt("cls", cls)
                    putString("label", CLASS_NAMES[cls])
                })
            }
            putArray("windowClassifications", classArray)
        }
    }

    // -------------------------------------------------------------------------
    // Event detection state machine
    // -------------------------------------------------------------------------

    data class ApneaEvent(
        val type: String,           // "apnea", "hypopnea", "snoring"
        val startSec: Float,
        val durationSec: Float,
        val confidence: Float,
    )

    private fun detectEvents(windows: List<Pair<Float, Int>>): List<ApneaEvent> {
        val events = mutableListOf<ApneaEvent>()
        val n = windows.size
        var i = 0

        while (i < n) {
            val (t, cls) = windows[i]

            if (cls == CLS_CESSATION) {
                // Count consecutive cessation windows
                var j = i
                while (j < n && windows[j].second == CLS_CESSATION) j++
                val cessationSecs = (j - i) * STRIDE_SECS

                // Look for recovery/gasp within RECOVERY_WINDOW_SECS
                val recoveryIdx = (j until n).firstOrNull { k ->
                    val elapsed = (windows[k].first - t)
                    elapsed <= RECOVERY_WINDOW_SECS &&
                    (windows[k].second == CLS_GASP || windows[k].second == CLS_RECOVERY)
                }

                if (cessationSecs >= CESSATION_MIN_SECS && recoveryIdx != null) {
                    events.add(ApneaEvent("apnea", t, cessationSecs, 0.85f))
                } else if (cessationSecs >= HYPOPNEA_MIN_SECS) {
                    events.add(ApneaEvent("hypopnea", t, cessationSecs, 0.70f))
                }
                i = j
            } else if (cls == CLS_SNORING) {
                // Track snoring bout
                var j = i
                while (j < n && windows[j].second == CLS_SNORING) j++
                val snoringDur = (j - i) * STRIDE_SECS
                if (snoringDur >= 10f) {
                    events.add(ApneaEvent("snoring", t, snoringDur, 0.80f))
                }
                i = j
            } else {
                i++
            }
        }
        return events
    }

    // -------------------------------------------------------------------------
    // Log-mel spectrogram (matches Python librosa config exactly)
    // -------------------------------------------------------------------------

    private fun computeLogMel(samples: FloatArray): Array<FloatArray> {
        val nSamples = samples.size

        // Pre-emphasis (mild, matches librosa default of none — skip for simplicity)
        // Apply Hann window per frame
        val melFilters = buildMelFilterBank()           // (N_MELS, N_FFT/2+1)
        val fftSize    = N_FFT
        val hopLen     = HOP_LENGTH
        val nFrames    = N_FRAMES

        val logMel = Array(N_MELS) { FloatArray(nFrames) }

        for (frame in 0 until nFrames) {
            val start = frame * hopLen
            val frameData = FloatArray(fftSize)
            for (k in 0 until fftSize) {
                val idx = start + k
                val sample = if (idx < nSamples) samples[idx] else 0f
                // Hann window
                val w = 0.5f * (1f - cos(2f * PI.toFloat() * k / (fftSize - 1)))
                frameData[k] = sample * w
            }

            // FFT → power spectrum
            val power = computePowerSpectrum(frameData)

            // Apply mel filter bank
            for (m in 0 until N_MELS) {
                var energy = 0f
                for (bin in power.indices) energy += melFilters[m][bin] * power[bin]
                // power_to_db: 10 * log10(energy / ref) where ref will be max
                logMel[m][frame] = energy.coerceAtLeast(1e-10f)
            }
        }

        // Convert to dB: 10*log10(S) - normalise by max
        var maxVal = 1e-10f
        for (m in 0 until N_MELS)
            for (f in 0 until nFrames)
                if (logMel[m][f] > maxVal) maxVal = logMel[m][f]

        for (m in 0 until N_MELS) {
            for (f in 0 until nFrames) {
                val db = 10f * log10(logMel[m][f] / maxVal)   // range: [-80, 0]
                logMel[m][f] = ((db + 80f) / 80f).coerceIn(0f, 1f)
            }
        }
        return logMel
    }

    /** Cooley-Tukey FFT → power spectrum [0..N_FFT/2]. */
    private fun computePowerSpectrum(frame: FloatArray): FloatArray {
        val n = frame.size
        val real = frame.copyOf()
        val imag = FloatArray(n)

        // Iterative Cooley-Tukey
        var half = n / 2
        var len = 2
        while (len <= n) {
            val wReal = cos(2 * PI / len).toFloat()
            val wImag = (-sin(2 * PI / len)).toFloat()
            var i = 0
            while (i < n) {
                var uReal = 1f; var uImag = 0f
                for (j in 0 until len / 2) {
                    val tReal = uReal * real[i + j + len/2] - uImag * imag[i + j + len/2]
                    val tImag = uReal * imag[i + j + len/2] + uImag * real[i + j + len/2]
                    real[i + j + len/2] = real[i + j] - tReal
                    imag[i + j + len/2] = imag[i + j] - tImag
                    real[i + j] += tReal
                    imag[i + j] += tImag
                    val newUReal = uReal * wReal - uImag * wImag
                    uImag = uReal * wImag + uImag * wReal
                    uReal = newUReal
                }
                i += len
            }
            len *= 2
        }

        // Bit-reversal permutation
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j xor bit
            if (i < j) {
                real[i] = real[j].also { real[j] = real[i] }
                imag[i] = imag[j].also { imag[j] = imag[i] }
            }
        }

        // Power spectrum (one-sided)
        val nBins = n / 2 + 1
        return FloatArray(nBins) { i -> real[i] * real[i] + imag[i] * imag[i] }
    }

    /** Build triangular mel filter bank — (N_MELS, N_FFT/2+1). */
    private fun buildMelFilterBank(): Array<FloatArray> {
        val nBins = N_FFT / 2 + 1
        fun hzToMel(hz: Float) = 2595f * log10(1f + hz / 700f)
        fun melToHz(mel: Float) = 700f * (10f.pow(mel / 2595f) - 1f)

        val melMin = hzToMel(FMIN)
        val melMax = hzToMel(FMAX)
        val melPoints = FloatArray(N_MELS + 2) { i ->
            melToHz(melMin + i * (melMax - melMin) / (N_MELS + 1))
        }
        val freqBins = FloatArray(nBins) { i -> i.toFloat() * SR / N_FFT }

        return Array(N_MELS) { m ->
            FloatArray(nBins) { k ->
                val f = freqBins[k]
                when {
                    f < melPoints[m] || f > melPoints[m + 2] -> 0f
                    f <= melPoints[m + 1] -> (f - melPoints[m]) / (melPoints[m + 1] - melPoints[m])
                    else                  -> (melPoints[m + 2] - f) / (melPoints[m + 2] - melPoints[m + 1])
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // TFLite inference
    // -------------------------------------------------------------------------

    private fun runInference(logMel: Array<FloatArray>): FloatArray {
        // Input: [1, N_MELS, N_FRAMES, 1]
        val input = Array(1) { Array(N_MELS) { m ->
            Array(N_FRAMES) { f -> FloatArray(1) { logMel[m][f] } }
        }}
        val output = Array(1) { FloatArray(CLASS_NAMES.size) }
        interpreter.run(input, output)
        return output[0]
    }

    private fun loadInterpreter(): org.tensorflow.lite.Interpreter {
        val model = loadModelFile()
        val options = org.tensorflow.lite.Interpreter.Options().apply {
            numThreads = 2
        }
        return org.tensorflow.lite.Interpreter(model, options)
    }

    private fun loadModelFile(): MappedByteBuffer {
        val assetFd = reactContext.assets.openFd(MODEL_ASSET)
        return FileInputStream(assetFd.fileDescriptor).channel.map(
            FileChannel.MapMode.READ_ONLY, assetFd.startOffset, assetFd.declaredLength
        )
    }

    // -------------------------------------------------------------------------
    // WAV loader (reads standard 16-bit PCM WAV)
    // -------------------------------------------------------------------------

    private fun loadWavSamples(path: String): FloatArray {
        val file = File(path)
        if (!file.exists()) throw IllegalArgumentException("File not found: $path")

        return file.inputStream().use { fis ->
            val header = ByteArray(44)
            fis.read(header)

            // Parse sample rate from header bytes 24-27 (little-endian)
            val fileSR = (header[24].toInt() and 0xFF) or
                         ((header[25].toInt() and 0xFF) shl 8) or
                         ((header[26].toInt() and 0xFF) shl 16) or
                         ((header[27].toInt() and 0xFF) shl 24)
            if (fileSR != SR) {
                Log.w(TAG, "WAV sample rate $fileSR ≠ expected $SR — continuing anyway")
            }

            val pcmBytes = fis.readBytes()
            FloatArray(pcmBytes.size / 2) { i ->
                val lo = pcmBytes[i * 2].toInt() and 0xFF
                val hi = pcmBytes[i * 2 + 1].toInt()
                val sample = (hi shl 8) or lo
                sample.toShort().toFloat() / 32768f
            }
        }
    }
}
