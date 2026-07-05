const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|[\u{FE0F}\u{200D}]|[\u{E0020}-\u{E007F}])+/gu

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE_RE = /`([^`]+)`/g
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const PARAGRAPH_BREAK_RE = /[ \t]*\n{2,}[ \t]*/g
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g

const THINKING_PREFIX_RE =
  /^\s*(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\.\s*/i

const URL_RE = /\bhttps?:\/\/\S+/gi

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
    .replace(PARAGRAPH_BREAK_RE, '. ')
    .replace(SOFT_BREAK_RE, ' ')
}

export function sanitizeTextForSpeech(text: string): string {
  const cleaned = normalizeLineBreaks(text)
    .replace(FENCED_CODE_RE, ' ')
    .replace(THINKING_PREFIX_RE, ' ')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(URL_RE, ' link ')
    .replace(EMOJI_RE, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

  // JARVIS: cap spoken length to avoid TTS backend timeouts. A butler speaks
  // concisely. Gemini/Edge TTS can take 15s+ on a paragraph; we cap at ~200
  // chars (≈2 spoken sentences) and cut at the last sentence boundary so the
  // audio never stops mid-phrase. The full response still shows in the chat.
  return capForSpeech(cleaned)
}

// JARVIS: cap spoken length to avoid TTS backend timeouts. A butler speaks
// concisely. Gemini TTS generates at ~28 chars/sec (per community benchmarks),
// so 1400 chars fits comfortably in the 60s backend timeout we set for TTS.
// Only extremely long responses (full essays) get cut at the last sentence
// boundary — the full text always remains visible in the chat.
const MAX_SPEECH_CHARS = 1400

function capForSpeech(text: string): string {
  if (text.length <= MAX_SPEECH_CHARS) {
    return text
  }

  const truncated = text.slice(0, MAX_SPEECH_CHARS)
  // Find the last sentence boundary (. ! ?) with at least ~40 chars before it,
  // so we keep at least one full sentence and don't cut too early.
  const boundary = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?')
  )

  if (boundary >= 40) {
    return truncated.slice(0, boundary + 1).trim()
  }

  // No good sentence boundary — fall back to the hard cap.
  return truncated.trim()
}
