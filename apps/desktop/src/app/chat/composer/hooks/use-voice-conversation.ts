import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { playSpeechText, stopVoicePlayback } from '@/lib/voice-playback'
import { notify, notifyError } from '@/store/notifications'
import { setConversationStatus, type JarvisVoiceStatus } from '@/store/voice-status'

import { useMicRecorder } from './use-mic-recorder'

export type ConversationStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

interface PendingVoiceResponse {
  id: string
  pending: boolean
  text: string
}

interface VoiceConversationOptions {
  busy: boolean
  enabled: boolean
  onFatalError?: () => void
  onSubmit: (text: string) => Promise<void> | void
  onTranscribeAudio?: (audio: Blob) => Promise<string>
  pendingResponse: () => PendingVoiceResponse | null
  consumePendingResponse: () => void
}

export function useVoiceConversation({
  busy,
  enabled,
  onFatalError,
  onSubmit,
  onTranscribeAudio,
  pendingResponse,
  consumePendingResponse
}: VoiceConversationOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const { handle, level } = useMicRecorder(voiceCopy)
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const [muted, setMuted] = useState(false)
  const turnTimeoutRef = useRef<number | null>(null)
  const pendingStartRef = useRef(false)
  const turnClosingRef = useRef(false)
  const awaitingSpokenResponseRef = useRef(false)
  const responseIdRef = useRef<string | null>(null)
  const spokenSourceLengthRef = useRef(0)
  const speechBufferRef = useRef('')
  const enabledRef = useRef(enabled)
  const mutedRef = useRef(muted)
  const busyRef = useRef(busy)
  const statusRef = useRef<ConversationStatus>('idle')
  const wasEnabledRef = useRef(enabled)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  // JARVIS: mirror the conversation status into the unified voice store so the
  // floating orb can react. Map the hook's 5 states to the orb's 4.
  useEffect(() => {
    const map: Record<ConversationStatus, JarvisVoiceStatus> = {
      idle: 'idle',
      listening: 'listening',
      transcribing: 'thinking',
      thinking: 'thinking',
      speaking: 'speaking'
    }
    setConversationStatus(map[status])
  }, [status])

  const clearTurnTimeout = () => {
    if (turnTimeoutRef.current) {
      window.clearTimeout(turnTimeoutRef.current)
      turnTimeoutRef.current = null
    }
  }

  const resetSpeechBuffer = () => {
    responseIdRef.current = null
    spokenSourceLengthRef.current = 0
    speechBufferRef.current = ''
  }

  const appendSpeechText = (text: string) => {
    if (!text) {
      return
    }

    speechBufferRef.current = `${speechBufferRef.current}${text}`
  }

  const takeSpeechChunk = (force = false): string | null => {
    const buffer = speechBufferRef.current.replace(/\s+/g, ' ').trim()

    if (!buffer) {
      speechBufferRef.current = ''

      return null
    }

    // JARVIS: accumulate more text before speaking to reduce TTS pauses.
    // Original Hermes cut at >= 8 chars, causing "hola... [pause] ...cómo estás".
    // Now we wait for a larger chunk (>= 40 chars) so the TTS generates longer,
    // more natural phrases. Multiple short sentences get joined into one call.
    const sentences: string[] = []
    let remaining = buffer
    while (sentences.length < 3) {
      const match = remaining.match(/^(.+?[.!?。！？])(?:\s+|$)/)
      if (!match) {
        break
      }
      sentences.push(match[1].trim())
      remaining = remaining.slice(match[1].length).trim()
    }

    // Speak when we have enough accumulated text, or when forced (stream ended).
    const joined = sentences.join(' ')
    if ((joined.length >= 40 || force) && sentences.length > 0) {
      speechBufferRef.current = remaining
      return joined
    }

    // Fallback: if buffer is very long without sentence boundaries, cut at a
    // soft boundary (comma/semicolon) — but at a higher threshold than before
    // to avoid tiny chunks.
    if (!force && buffer.length > 350) {
      const softBoundary = Math.max(
        buffer.lastIndexOf(', ', 280),
        buffer.lastIndexOf('; ', 280),
        buffer.lastIndexOf(': ', 280)
      )

      if (softBoundary > 120) {
        const chunk = buffer.slice(0, softBoundary + 1).trim()
        speechBufferRef.current = buffer.slice(softBoundary + 1).trim()

        return chunk
      }
    }

    if (!force) {
      return null
    }

    speechBufferRef.current = ''

    return buffer
  }

  const handleTurn = useCallback(
    async (forceTranscribe = false) => {
      if (turnClosingRef.current) {
        return
      }

      turnClosingRef.current = true
      clearTurnTimeout()
      setStatus('transcribing')

      try {
        const result = await handle.stop()

        if (!result || (!result.heardSpeech && !forceTranscribe) || !onTranscribeAudio) {
          if (enabledRef.current && !mutedRef.current && !busyRef.current && statusRef.current !== 'speaking') {
            pendingStartRef.current = true
          }

          setStatus('idle')

          return
        }

        try {
          const transcript = (await onTranscribeAudio(result.audio)).trim()

          if (!transcript) {
            if (enabledRef.current) {
              pendingStartRef.current = true
            }

            setStatus('idle')

            return
          }

          awaitingSpokenResponseRef.current = true
          resetSpeechBuffer()
          await onSubmit(transcript)
          setStatus('thinking')
        } catch (error) {
          notifyError(error, voiceCopy.transcriptionFailed)

          if (enabledRef.current && !mutedRef.current && !busyRef.current) {
            pendingStartRef.current = true
          }

          setStatus('idle')
        }
      } finally {
        turnClosingRef.current = false
      }
    },
    [handle, onSubmit, onTranscribeAudio, voiceCopy.transcriptionFailed]
  )

  const startListening = useCallback(async () => {
    pendingStartRef.current = false

    if (!enabledRef.current || mutedRef.current || busyRef.current) {
      return
    }

    if (statusRef.current !== 'idle') {
      return
    }

    try {
      // VAD tuning mirrors `tools.voice_mode` defaults so the browser loop matches the CLI.
      // JARVIS: idleSilenceMs reduced to 4s so the mic closes after 4s of total
      // silence (instead of the default 12s). Combined with the onIdleTimeout
      // handler below, this ends the conversation when the user stops talking —
      // the external OpenWakeWord daemon re-arms it on the next "hey jarvis".
      // silenceLevel raised to 0.12 so room ambience/fan noise doesn't keep the
      // mic open indefinitely after the user stops speaking.
      await handle.start({
        silenceLevel: 0.09,
        silenceMs: 3000,
        idleSilenceMs: 2_000,
        onError: error => {
          notifyError(error, voiceCopy.microphoneFailed)
          pendingStartRef.current = false
          onFatalError?.()
        },
        onSilence: () => void handleTurn(),
        // JARVIS: when the user never speaks for the whole idle window, close
        // the mic and turn voice mode OFF. The wake-word daemon will turn it
        // back on. This is the "movie style" behavior — silence ends the session.
        onIdleTimeout: () => {
          handle.cancel()
          pendingStartRef.current = false
          awaitingSpokenResponseRef.current = false
          resetSpeechBuffer()
          consumePendingResponse()
          setStatus('idle')
          // Signal the parent to flip voice mode off.
          onFatalError?.()
        }
      })
      setStatus('listening')
      turnTimeoutRef.current = window.setTimeout(() => void handleTurn(), 60_000)
    } catch (error) {
      notifyError(error, voiceCopy.couldNotStartSession)
      pendingStartRef.current = false
      setStatus('idle')
      onFatalError?.()
    }
  }, [handle, handleTurn, onFatalError, voiceCopy.couldNotStartSession, voiceCopy.microphoneFailed])

  const speak = useCallback(
    async (text: string) => {
      setStatus('speaking')

      try {
        await playSpeechText(text, { source: 'voice-conversation' })
      } catch (error) {
        notifyError(error, voiceCopy.playbackFailed)
      } finally {
        // JARVIS (estilo película): después de hablar, apagar el voice mode
        // por completo. El micro se cierra y la UI se limpia (sin "...end").
        // El usuario dice "Alexa" para reactivarlo (el wake bridge llama a
        // requestVoiceToggle que lo vuelve a encender).
        pendingStartRef.current = false
        awaitingSpokenResponseRef.current = false
        resetSpeechBuffer()
        consumePendingResponse()
        clearTurnTimeout()
        stopVoicePlayback()
        handle.cancel()
        turnClosingRef.current = false
        setMuted(false)
        setStatus('idle')
        // Signal the parent to turn voice mode OFF (clears the UI).
        onFatalError?.()
      }
    },
    [voiceCopy.playbackFailed]
  )

  const start = useCallback(async () => {
    if (!onTranscribeAudio) {
      notify({
        kind: 'warning',
        title: voiceCopy.unavailable,
        message: voiceCopy.configureSpeechToText
      })
      onFatalError?.()

      return
    }

    setMuted(false)
    awaitingSpokenResponseRef.current = false
    resetSpeechBuffer()
    consumePendingResponse()
    pendingStartRef.current = true
    await startListening()
  }, [
    consumePendingResponse,
    onFatalError,
    onTranscribeAudio,
    startListening,
    voiceCopy.configureSpeechToText,
    voiceCopy.unavailable
  ])

  const end = useCallback(async () => {
    pendingStartRef.current = false
    clearTurnTimeout()
    stopVoicePlayback()
    handle.cancel()
    turnClosingRef.current = false
    awaitingSpokenResponseRef.current = false
    resetSpeechBuffer()
    consumePendingResponse()
    setMuted(false)
    setStatus('idle')
  }, [consumePendingResponse, handle])

  const stopTurn = useCallback(() => {
    if (statusRef.current === 'listening') {
      void handleTurn(true)
    }
  }, [handleTurn])

  const toggleMute = useCallback(() => {
    setMuted(value => {
      const next = !value

      if (next) {
        clearTurnTimeout()
        handle.cancel()
        setStatus('idle')
      } else if (enabledRef.current && !busyRef.current && statusRef.current === 'idle') {
        pendingStartRef.current = true
      }

      return next
    })
  }, [handle])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (statusRef.current !== 'listening') {
        return
      }

      event.preventDefault()
      stopTurn()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, stopTurn])

  // Drive the loop: after a voice-submitted turn, speak stable chunks as the
  // assistant stream grows. Otherwise start listening when idle between turns.
  useEffect(() => {
    if (!enabled || muted) {
      return
    }

    if (awaitingSpokenResponseRef.current && status !== 'speaking') {
      const response = pendingResponse()

      if (response) {
        if (response.id !== responseIdRef.current) {
          resetSpeechBuffer()
          responseIdRef.current = response.id
        }

        if (response.text.length > spokenSourceLengthRef.current) {
          appendSpeechText(response.text.slice(spokenSourceLengthRef.current))
          spokenSourceLengthRef.current = response.text.length
        }

        // JARVIS: wait for the FULL response before speaking. This eliminates
        // all mid-sentence TTS pauses — one single TTS call, natural prosody.
        // Trade-off: a longer initial silence before JARVIS starts talking,
        // but the voice sounds fluid and human instead of choppy.
        const responseComplete = !response.pending && !busy

        if (responseComplete) {
          // Speak everything that accumulated, in one shot.
          const fullText = speechBufferRef.current.replace(/\s+/g, ' ').trim()

          if (fullText) {
            speechBufferRef.current = ''
            void speak(fullText)
            return
          }

          // No text to speak — go back to listening.
          awaitingSpokenResponseRef.current = false
          consumePendingResponse()
          resetSpeechBuffer()
          pendingStartRef.current = true
          setStatus('idle')

          return
        }

        // Response still streaming — keep buffering, don't speak yet.
        return
      }

      if (!busy && status === 'thinking') {
        awaitingSpokenResponseRef.current = false
        resetSpeechBuffer()
        pendingStartRef.current = true
        setStatus('idle')

        return
      }
    }

    if (busy || status !== 'idle') {
      return
    }

    if (pendingStartRef.current) {
      void startListening()
    }
  }, [busy, consumePendingResponse, enabled, muted, pendingResponse, speak, startListening, status])

  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      void start()
    }

    if (!enabled && wasEnabledRef.current) {
      void end()
    }

    wasEnabledRef.current = enabled
  }, [enabled, end, start])

  return { end, level, muted, start, status, stopTurn, toggleMute }
}
