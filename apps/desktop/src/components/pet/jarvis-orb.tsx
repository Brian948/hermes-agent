import { memo, useEffect, useMemo, useRef } from 'react'

import { $petState, type PetInfo, type PetState } from '@/store/pet'

const DEFAULT_SCALE = 0.33
const DEFAULT_ORB_SIZE = 120

/**
 * Map Hermes pet states to JARVIS orb visual states.
 * Each state controls glow intensity, rotation speed, pulse, and particle behavior.
 */
type OrbState = 'idle' | 'active' | 'listening' | 'error' | 'waiting'

const STATE_MAP: Record<PetState, OrbState> = {
  idle: 'idle',
  wave: 'listening',
  jump: 'active',
  run: 'active',
  failed: 'error',
  review: 'active',
  waiting: 'waiting'
}

interface OrbConfig {
  glowColor: string
  coreColor: string
  particleColor: string
  errorColor: string
  textureUrl?: string
  showParticles: boolean
}

const DEFAULT_CONFIG: OrbConfig = {
  coreColor: '#00d4ff',
  errorColor: '#ff2040',
  glowColor: '#0088ff',
  particleColor: '#00d4ff',
  showParticles: true
}

interface Particle {
  angle: number
  dist: number
  radius: number
  speed: number
  opacity: number
  opacityDir: number
}

interface JarvisOrbProps {
  info: PetInfo
  zoom?: number
  stateOverride?: PetState
  rowOverride?: string
}

/**
 * JARVIS-style animated orb. Drop-in replacement for PetSprite that renders
 * a futuristic glowing sphere with particles and state-dependent animations.
 *
 * Uses Canvas 2D for rendering (performant, low overhead). The orb reacts to
 * the same $petState as PetSprite — no extra wiring needed.
 */
function JarvisOrbImpl({ info, zoom = 1, stateOverride }: JarvisOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<OrbState>('idle')
  const animRef = useRef<number>(0)
  const frameRef = useRef(0)
  const particlesRef = useRef<Particle[]>([])
  const configRef = useRef<OrbConfig>(DEFAULT_CONFIG)

  const scale = (info.scale ?? DEFAULT_SCALE) * zoom
  const size = Math.round(DEFAULT_ORB_SIZE * scale)

  // Resolve orb visual state from pet state (same subscription as PetSprite)
  useEffect(() => {
    stateRef.current = STATE_MAP[$petState.get()]

    const unsub = $petState.listen(next => {
      stateRef.current = STATE_MAP[next]
    })

    return unsub
  }, [])

  // Initialize particles
  useEffect(() => {
    const count = 24
    particlesRef.current = Array.from({ length: count }, (_, i) => ({
      angle: (Math.PI * 2 * i) / count,
      dist: 0.6 + Math.random() * 0.25,
      radius: 1 + Math.random() * 2,
      speed: 0.003 + Math.random() * 0.008,
      opacity: 0.3 + Math.random() * 0.7,
      opacityDir: (Math.random() - 0.5) * 0.02
    }))
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    if (!ctx) {
      return
    }

    const config = configRef.current
    let rotation = 0
    let pulsePhase = 0

    // State animation parameters
    const stateParams = {
      idle: { rotationSpeed: 0.003, pulseAmp: 0.04, pulseSpeed: 0.02, glowAlpha: 0.3 },
      active: { rotationSpeed: 0.012, pulseAmp: 0.08, pulseSpeed: 0.04, glowAlpha: 0.6 },
      listening: { rotationSpeed: 0.006, pulseAmp: 0.12, pulseSpeed: 0.06, glowAlpha: 0.8 },
      error: { rotationSpeed: 0.002, pulseAmp: 0.03, pulseSpeed: 0.08, glowAlpha: 0.5 },
      waiting: { rotationSpeed: 0.004, pulseAmp: 0.05, pulseSpeed: 0.015, glowAlpha: 0.25 }
    }

    const render = () => {
      const state = stateRef.current
      const params = stateParams[state]
      const w = canvas.width
      const h = canvas.height
      const cx = w / 2
      const cy = h / 2
      const baseRadius = Math.max(1, w * 0.3)
      const pulse = Math.sin(pulsePhase) * params.pulseAmp
      const radius = Math.max(1, baseRadius * (1 + pulse))

      // Error state blinks
      const isError = state === 'error'
      const blinkOn = isError ? Math.sin(pulsePhase * 3) > -0.3 : true

      ctx.clearRect(0, 0, w, h)

      if (!blinkOn) {
        // Still tick animations for smooth transition out of blink
        rotation += params.rotationSpeed
        pulsePhase += params.pulseSpeed
        animRef.current = requestAnimationFrame(render)

        return
      }

      // Draw outer glow (layered radial gradients for depth)
      const glowRadius = Math.max(2, radius * 2.2)
      const glow = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, glowRadius)

      const color = isError ? config.errorColor : config.glowColor
      glow.addColorStop(0, color + hexAlpha(params.glowAlpha * 0.6))
      glow.addColorStop(0.4, color + hexAlpha(params.glowAlpha * 0.3))
      glow.addColorStop(0.7, color + hexAlpha(params.glowAlpha * 0.1))
      glow.addColorStop(1, color + '00')

      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2)
      ctx.fill()

      // Draw rotating ring
      const ringRadius = Math.max(2, radius * 1.15)
      const ringWidth = Math.max(1, radius * 0.03)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(rotation)
      ctx.strokeStyle = color + hexAlpha(0.6)
      ctx.lineWidth = ringWidth
      ctx.beginPath()
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2)
      ctx.stroke()

      // Draw ring markers (ticks)
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI * 2 * i) / 12
        const inner = ringRadius - ringWidth * 2
        const outer = ringRadius + ringWidth * 2

        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer)
        ctx.strokeStyle = color + hexAlpha(i % 3 === 0 ? 0.8 : 0.3)
        ctx.lineWidth = i % 3 === 0 ? ringWidth * 1.5 : ringWidth
        ctx.stroke()
      }

      ctx.restore()

      // Draw core sphere
      const coreGrad = ctx.createRadialGradient(
        cx - radius * 0.2,
        cy - radius * 0.2,
        Math.max(1, radius * 0.1),
        cx,
        cy,
        radius
      )

      const coreColor = isError ? config.errorColor : config.coreColor
      coreGrad.addColorStop(0, '#ffffff')
      coreGrad.addColorStop(0.3, coreColor + 'ff')
      coreGrad.addColorStop(0.7, coreColor + hexAlpha(0.8))
      coreGrad.addColorStop(1, coreColor + hexAlpha(0.3))

      ctx.fillStyle = coreGrad
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()

      // Inner highlight (specular)
      const hlGrad = ctx.createRadialGradient(
        cx - radius * 0.25,
        cy - radius * 0.25,
        0,
        cx - radius * 0.25,
        cy - radius * 0.25,
        Math.max(1, radius * 0.5)
      )

      hlGrad.addColorStop(0, 'rgba(255,255,255,0.35)')
      hlGrad.addColorStop(1, 'rgba(255,255,255,0)')

      ctx.fillStyle = hlGrad
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()

      // Draw particles
      if (config.showParticles) {
        const particles = particlesRef.current
        const pColor = isError ? config.errorColor : config.particleColor

        for (const p of particles) {
          p.angle += p.speed * (state === 'active' ? 2 : 1)
          p.opacity += p.opacityDir

          if (p.opacity >= 1 || p.opacity <= 0.1) {
            p.opacityDir *= -1
            p.opacity = Math.max(0.1, Math.min(1, p.opacity))
          }

          const pDist = radius * p.dist * 1.4
          const px = cx + Math.cos(p.angle) * pDist
          const py = cy + Math.sin(p.angle) * pDist

          ctx.fillStyle = pColor + hexAlpha(p.opacity * 0.7)
          ctx.beginPath()
          ctx.arc(px, py, p.radius * scale, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      rotation += params.rotationSpeed
      pulsePhase += params.pulseSpeed
      frameRef.current += 1

      animRef.current = requestAnimationFrame(render)
    }

    animRef.current = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(animRef.current)
    }
  }, [scale])

  return (
    <canvas
      aria-label="JARVIS orb"
      height={size}
      ref={canvasRef}
      style={{ height: size, width: size }}
      width={size}
    />
  )
}

/** Convert 0-1 opacity to 2-char hex suffix. */
function hexAlpha(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, '0')
}

export const JarvisOrb = memo(JarvisOrbImpl)
