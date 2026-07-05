/**
 * Silero VAD wrapper for the browser.
 *
 * Loads the Silero Voice Activity Detection ONNX model and runs it on the
 * live mic audio to distinguish speech from noise/silence. Much more accurate
 * than the simple RMS-volume detector, especially in noisy rooms where a fan
 * or air conditioner keeps the RMS above threshold constantly.
 *
 * The model is downloaded once from the Silero Hugging Face mirror and cached
 * by the browser. It expects 16 kHz mono float32 PCM in 512-sample (32 ms)
 * chunks and returns a single probability [0..1] of speech.
 *
 * Reference: https://github.com/snakers4/silero-vad
 */

import { InferenceSession, Tensor } from 'onnxruntime-web'

const MODEL_URL =
  'https://huggingface.co/silero/silero-vad/resolve/main/src/silero_vad/data/silero_vad.onnx'

const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 512 // 32 ms at 16 kHz — Silero's expected input

// h (LSTM hidden state), c (LSTM cell state) — kept across calls so the model
// has temporal context. Reset before each recording session.
interface VadState {
  h: Tensor
  c: Tensor
}

let sessionPromise: Promise<InferenceSession> | null = null

/** Lazily load the ONNX session (singleton — the model is ~2 MB). */
async function getSession(): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = InferenceSession.create(MODEL_URL, {
      executionProviders: ['cpu']
    }).catch(error => {
      sessionPromise = null // allow retry on failure
      throw error
    })
  }
  return sessionPromise
}

function freshState(): VadState {
  return {
    c: new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
    h: new Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64])
  }
}

export interface SileroVadHandle {
  /** Run the model on a 512-sample float32 chunk → speech probability [0..1]. */
  predict(chunk: Float32Array): Promise<number>
  /** Reset LSTM state — call before each new recording session. */
  reset(): void
}

/** Is onnxruntime-web available (the desktop bundles it for the terminal)? */
export function isSileroVadAvailable(): boolean {
  try {
    return typeof InferenceSession !== 'undefined'
  } catch {
    return false
  }
}

export async function createSileroVad(): Promise<SileroVadHandle> {
  const session = await getSession()
  let state = freshState()

  return {
    async predict(chunk: Float32Array): Promise<number> {
      if (chunk.length !== CHUNK_SAMPLES) {
        // Pad/truncate to the expected size — Silero is strict about it.
        const fixed = new Float32Array(CHUNK_SAMPLES)
        const n = Math.min(chunk.length, CHUNK_SAMPLES)
        fixed.set(chunk.subarray(0, n))
        chunk = fixed
      }

      const input = new Tensor('float32', chunk, [1, CHUNK_SAMPLES])
      const sr = new Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1])

      const feeds: Record<string, Tensor> = {
        input,
        h: state.h,
        c: state.c,
        sr
      }

      const output = await session.run(feeds)
      const prob = (output.output?.data?.[0] as number) ?? 0

      // Update LSTM state if the model returns it (newer Silero versions do).
      if (output.hn && output.cn) {
        state.h = output.hn
        state.c = output.cn
      }

      return Math.max(0, Math.min(1, prob))
    },

    reset() {
      state = freshState()
    }
  }
}

/** Resample an AudioBuffer's channel to 16 kHz mono float32. */
export function resampleTo16k(audioContext: AudioContext, buffer: AudioBuffer): Float32Array {
  const targetLength = Math.round((buffer.length * SAMPLE_RATE) / buffer.sampleRate)
  const offline = new OfflineAudioContext(1, targetLength, SAMPLE_RATE)
  const source = offline.createBufferSource()
  // Downmix to mono
  const mono = buffer.getChannelData(0)
  const monoBuffer = offline.createBuffer(1, mono.length, buffer.sampleRate)
  monoBuffer.copyToChannel(mono, 0)
  source.buffer = monoBuffer
  source.connect(offline.destination)
  source.start()
  // Synchronous render via startRendering (returns a Promise in modern browsers)
  // — but we want a sync helper, so callers must await offline.startRendering()
  // themselves. This helper is intentionally minimal.
  throw new Error('use resampleBufferAsync instead')
}

export async function resampleBufferAsync(buffer: AudioBuffer): Promise<Float32Array> {
  const targetLength = Math.round((buffer.length * SAMPLE_RATE) / buffer.sampleRate)
  const offline = new OfflineAudioContext(1, targetLength, SAMPLE_RATE)
  const source = offline.createBufferSource()
  const mono = buffer.getChannelData(0)
  const monoBuffer = offline.createBuffer(1, mono.length, buffer.sampleRate)
  monoBuffer.copyToChannel(mono, 0)
  source.buffer = monoBuffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}
