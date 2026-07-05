import { atom } from 'nanostores'

/**
 * Unified JARVIS voice status.
 *
 * Single source of truth that the JarvisOrb subscribes to. Fed by both the
 * voice-conversation hook (listening/thinking/speaking) and the voice-playback
 * store (speaking from read-aloud). The orb picks the most "active" state so a
 * turn-in-progress always wins over idle.
 *
 *   idle       — nothing happening, orb glows softly
 *   listening  — user is speaking, orb pulses bright (wave-like)
 *   thinking   — agent is processing, orb rotates fast with sparks
 *   speaking   — agent is talking back, orb pulses with energy
 */

export type JarvisVoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

// Priority order — higher index wins when merging sources.
const PRIORITY: JarvisVoiceStatus[] = ['idle', 'listening', 'thinking', 'speaking']

export const $voiceStatus = atom<JarvisVoiceStatus>('idle')

/** Set the status from the voice-conversation hook. */
export function setConversationStatus(status: JarvisVoiceStatus): void {
  $voiceStatus.set(status)
}

/** Reset to idle (e.g. conversation ended). */
export function resetVoiceStatus(): void {
  $voiceStatus.set('idle')
}
