/**
 * JARVIS Wake Word Bridge (WebSocket).
 *
 * Connects to the OpenWakeWord daemon's WebSocket server (ws://127.0.0.1:8765)
 * and activates Hermes' voice conversation mode when the wake word fires.
 *
 * The daemon broadcasts a JSON payload `{wake, word, ts}` to every connected
 * client. We subscribe, and on wake:
 *   1. Show + focus the window (it may be hidden to tray).
 *   2. Toggle the voice conversation on (start listening).
 *
 * Robust: auto-reconnects if the daemon restarts. No files, no polling, no
 * hardcoded paths — just a clean local WebSocket.
 */

import { useEffect, useRef } from 'react'

import { requestVoiceToggle } from '@/app/chat/composer/focus'
import { stopVoicePlayback } from '@/lib/voice-playback'
import { $voiceStatus } from '@/store/voice-status'

const WS_URL = 'ws://127.0.0.1:8765'
const RECONNECT_MS = 2000

interface JarvisBridgeOptions {
  /** Only run in the primary window (the one that owns voice state). */
  enabled: boolean
}

export function useJarvisWakeBridge({ enabled }: JarvisBridgeOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let active = true

    const connect = () => {
      if (!active) {
        return
      }

      let ws: WebSocket
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        // Daemon not up yet — retry shortly.
        reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_MS)
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        // Connected — the daemon will push wake events.
      }

      ws.onmessage = event => {
        try {
          const payload = JSON.parse(event.data)
          if (payload?.wake) {
            onWakeWordDetected(payload.word)
          }
        } catch {
          // Ignore malformed messages.
        }
      }

      ws.onclose = () => {
        if (!active) return
        wsRef.current = null
        // Daemon went away — reconnect until it's back.
        reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_MS)
      }

      ws.onerror = () => {
        // The close handler will trigger reconnect.
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    }

    connect()

    return () => {
      active = false
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {
          // ignore
        }
      }
    }
  }, [enabled])
}

/**
 * Wake word fired — show the window and start voice mode.
 *
 * Barge-in: if JARVIS is currently speaking, the wake word cuts the TTS
 * immediately so the user can talk over it (just like the movies: "Jarvis,
 * basta"). The wake word always wins — it never gets muted.
 */
function onWakeWordDetected(word?: string) {
  // Ask the main process to show + focus the window (it may be hidden to tray).
  try {
    window.hermesDesktop?.onJarvisPopOrb?.(() => {})
  } catch {
    // Optional API — ignore if absent.
  }

  // BARGE-IN: if JARVIS is speaking, stop the TTS immediately and unmute the
  // wake word. The voice status will flip to idle so the loop re-arms.
  const current = $voiceStatus.get()
  if (current === 'speaking' || current === 'thinking') {
    stopVoicePlayback()
    // Unmute the wake word daemon (TTS mute was on during speech).
    window.hermesDesktop?.setJarvisTtsMute?.(false)
  }

  // Toggle the voice conversation on — Hermes starts listening immediately.
  requestVoiceToggle()
}
