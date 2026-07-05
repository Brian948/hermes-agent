#!/usr/bin/env python3
"""
JARVIS Wake Word Daemon.

Listens to the microphone continuously and detects the configured wake word
(default: "hey jarvis") using OpenWakeWord. When detected, it signals the
Hermes Desktop app to activate (open the window + start voice mode).

Runs as a separate process — does NOT touch the Hermes core. Talks to the
desktop app via HTTP (the Vite dev server or the packaged renderer).

Configuration: jarvis-config.json (same folder as this script).
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
from openwakeword import Model
from openwakeword.utils import download_models

# ─── Config ─────────────────────────────────────────────────────────────────
CONFIG_PATH = Path(__file__).parent / "jarvis-config.json"


def load_config() -> dict:
    defaults = {
        "wake_word": "hey jarvis",
        "sensitivity": 0.5,
        "cooldown_seconds": 3,
        "desktop_port": 5174,
        "log_detection": True,
        "log_scores": False,
        "mic_gain": 1.0,
    }
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                user = json.load(f)
            defaults.update(user)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[jarvis] Warning: could not read config ({e}), using defaults")
    return defaults


CONFIG = load_config()
WAKE_WORD = CONFIG["wake_word"]
SENSITIVITY = CONFIG["sensitivity"]
COOLDOWN = CONFIG["cooldown_seconds"]
DESKTOP_PORT = CONFIG["desktop_port"]
LOG = CONFIG["log_detection"]
LOG_SCORES = CONFIG.get("log_scores", False)
MIC_GAIN = CONFIG.get("mic_gain", 1.0)
CUSTOM_MODEL_PATH = CONFIG.get("custom_model_path")

# OpenWakeWord runs at 16 kHz mono.
SAMPLE_RATE = 16000
CHUNK_MS = 80  # OpenWakeWord expects 80 ms chunks (1280 samples at 16 kHz)
CHUNK_SIZE = SAMPLE_RATE * CHUNK_MS // 1000  # 1280

# Map wake_word config → OpenWakeWord model names. OpenWakeWord ships these
# pretrained models. Add new entries here when you train custom models.
AVAILABLE_MODELS = [
    "hey jarvis",
    "alexa",
    "hey mycroft",
    "computer",
    "hey terminator",
    "hey beethoven",
]

# TTS active signal: while JARVIS is speaking, the desktop writes this file.
# Instead of fully muting (which blocks barge-in), we RAISE the sensitivity
# threshold so the user can still interrupt with a loud "ALEXA!" while the
# quieter TTS voice coming through the speakers is ignored.
TTS_ACTIVE_SIGNAL = Path(__file__).parent / "tts_active.signal"
# Higher threshold during TTS playback (parlante echo guard).
SENSITIVITY_DURING_TTS = max(SENSITIVITY + 0.3, 0.7)


def is_tts_active() -> bool:
    """True while JARVIS is speaking — the desktop toggles this file."""
    try:
        return TTS_ACTIVE_SIGNAL.exists()
    except OSError:
        return False


def current_sensitivity() -> float:
    """Sensitivity depends on whether JARVIS is speaking.
    Normal: user-set sensitivity (e.g. 0.4) — voice at normal volume triggers.
    During TTS: higher sensitivity (e.g. 0.7) — only a loud 'ALEXA!' triggers,
    so the TTS voice from the speakers doesn't auto-activate but the user can
    still interrupt (barge-in).
    """
    return SENSITIVITY_DURING_TTS if is_tts_active() else SENSITIVITY



# WebSocket clients (the desktop renderer connects here to receive wake events).
# Kept as a module-level set so the signal function can broadcast to all of them.
WS_CLIENTS = set()
WS_PORT = 8765  # dedicated port for the wake-word WebSocket bridge


def signal_desktop() -> bool:
    """
    Broadcast the wake event to all connected desktop clients via WebSocket.
    Instant and reliable — no files, no HTTP polling.
    """
    print(f"\n[WAKE] {WAKE_WORD} detected! Broadcasting via WebSocket...")
    sys.stdout.flush()

    import asyncio
    import json

    payload = json.dumps({"wake": True, "word": WAKE_WORD, "ts": time.time()})

    # Broadcast to every connected desktop client (best-effort, non-blocking).
    sent = 0
    for ws in list(WS_CLIENTS):
        try:
            asyncio.run_coroutine_threadsafe(ws.send(payload), WS_LOOP)
            sent += 1
        except Exception:
            # Client will be cleaned up by its handler on disconnect.
            pass

    if sent == 0:
        print(f"[WAKE] ⚠️ No desktop client connected ({len(WS_CLIENTS)} in set) — start Hermes Desktop first.")
        return False

    print(f"[WAKE] ✅ Signal sent to {sent} desktop client(s).")
    return True


# ─── WebSocket server (runs in a background thread) ─────────────────────────
WS_LOOP = None


def start_ws_server() -> None:
    """Start a localhost WebSocket server the desktop connects to for wake events."""
    import asyncio
    import websockets

    async def handler(websocket):
        WS_CLIENTS.add(websocket)
        peer = websocket.remote_address if hasattr(websocket, 'remote_address') else '?'
        print(f"[ws] Desktop client connected from {peer} (total: {len(WS_CLIENTS)})")
        try:
            # Keep the connection open; we don't expect messages from the desktop.
            # Just await forever so the connection stays alive until the client
            # disconnects or errors.
            await websocket.wait_closed()
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception:
            pass
        finally:
            WS_CLIENTS.discard(websocket)
            print(f"[ws] Desktop client disconnected ({peer}) (total: {len(WS_CLIENTS)})")

    async def main_loop():
        global WS_LOOP
        WS_LOOP = asyncio.get_running_loop()
        async with websockets.serve(handler, "127.0.0.1", WS_PORT):
            print(f"[ws] WebSocket server listening on ws://127.0.0.1:{WS_PORT}")
            await asyncio.Future()  # run forever

    def run():
        try:
            asyncio.run(main_loop())
        except Exception as e:
            print(f"[ws] Server error: {e}")

    import threading
    t = threading.Thread(target=run, daemon=True)
    t.start()



def main() -> int:
    print("=" * 60)
    print("  JARVIS Wake Word Daemon")
    print("=" * 60)
    print(f"  Wake word:   {WAKE_WORD}")
    print(f"  Sensitivity: {SENSITIVITY}")
    print(f"  Cooldown:    {COOLDOWN}s")
    print(f"  Mic gain:    {MIC_GAIN}x")
    print(f"  Desktop:     http://127.0.0.1:{DESKTOP_PORT}")
    print(f"  Debug scores: {'ON' if LOG_SCORES else 'OFF'}")
    print("=" * 60)

    # Normalize the configured wake word to a model OpenWakeWord knows.
    # Custom models (set via custom_model_path in the config) bypass this check
    # since they aren't in the built-in AVAILABLE_MODELS list.
    model_name = WAKE_WORD.strip().lower()
    has_custom = bool(CUSTOM_MODEL_PATH) and (Path(__file__).parent / CUSTOM_MODEL_PATH).exists()
    if model_name not in AVAILABLE_MODELS and not has_custom:
        print(f"\n[jarvis] Wake word '{WAKE_WORD}' is not a built-in model.")
        print(f"[jarvis] Available: {', '.join(AVAILABLE_MODELS)}")
        print(f"[jarvis] Falling back to 'hey jarvis'. Edit jarvis-config.json to change.")
        model_name = "hey jarvis"
    elif has_custom:
        print(f"\n[jarvis] Custom model configured: {CUSTOM_MODEL_PATH}")

    print(f"\n[jarvis] Loading OpenWakeWord model '{model_name}'...")

    # Try to load the custom-trained model first (e.g. DANTE trained with your voice).
    # Falls back to downloading the built-in models if no custom model is configured.
    custom_full_path = None
    if CUSTOM_MODEL_PATH:
        custom_full_path = Path(__file__).parent / CUSTOM_MODEL_PATH
        if not custom_full_path.exists():
            print(f"[jarvis] Custom model not found at {custom_full_path}")
            custom_full_path = None

    if custom_full_path:
        print(f"[jarvis] Using custom model: {custom_full_path.name}")
        try:
            # Custom models are trained by us — load the file directly with the
            # OpenWakeWord framework ONNX models (melspec + embedding) alongside.
            download_models()  # ensure base melspec/embedding ONNX are present
            oww = Model(wakeword_models=[str(custom_full_path)], inference_framework="onnx")
            # Custom models report scores under the model's filename stem.
            model_name = custom_full_path.stem
        except Exception as e:
            print(f"[jarvis] Error loading custom model: {e}")
            print(f"[jarvis] Falling back to built-in model '{WAKE_WORD}'...")
            custom_full_path = None

    if not custom_full_path:
        # Built-in model path (needs download on first run)
        try:
            print("[jarvis] Ensuring built-in models are downloaded (first run takes a minute)...")
            download_models()
        except Exception as e:
            print(f"[jarvis] Model download warning: {e}")

        try:
            oww = Model(wakeword_models=[model_name], inference_framework="onnx")
        except Exception as e:
            print(f"[jarvis] Error loading model: {e}")
            print(f"[jarvis] Available models will be in the openwakeword/resources/models/ folder after download.")
            return 1
    print("[jarvis] Model loaded. Listening... (Ctrl+C to stop)\n")

    last_detection = 0.0

    def audio_callback(indata: np.ndarray, frames: int, time_info, status):
        nonlocal last_detection
        if status:
            if LOG:
                print(f"[jarvis] audio status: {status}", file=sys.stderr)

        # OpenWakeWord expects int16 mono at 16 kHz. sounddevice gives float32.
        # Apply software mic gain to boost quiet input (config: mic_gain).
        audio_float = indata[:, 0] * MIC_GAIN
        # Clamp to valid float32 range to avoid clipping distortion.
        audio_float = np.clip(audio_float, -1.0, 1.0)
        audio_int16 = (audio_float * 32767).astype(np.int16)

        prediction = oww.predict(audio_int16)
        score = prediction.get(model_name, 0.0)

        # Debug: print scores so you can see what the model hears.
        if LOG_SCORES and score > 0.05:
            bar = "#" * int(score * 20)
            print(f"  {model_name}: {score:.2f} {bar}", end="\r", flush=True)

        now = time.time()
        # Dynamic sensitivity: during TTS playback the threshold is raised so
        # the user can still barge-in with a loud "ALEXA!" while the quieter
        # TTS voice from the speakers is ignored (acoustic echo guard without
        # fully blocking the wake word).
        threshold = current_sensitivity()
        if score >= threshold and (now - last_detection) >= COOLDOWN:
            last_detection = now
            if LOG:
                print(f"\n[jarvis] DETECTED '{model_name}' (score={score:.2f})    ")
            signal_desktop()

    # Start the WebSocket bridge server (desktop connects here for wake events).
    start_ws_server()

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            blocksize=CHUNK_SIZE,
            dtype="float32",
            callback=audio_callback,
        ):
            # Keep the process alive; the InputStream runs on its own thread.
            while True:
                sd.sleep(1000)
    except KeyboardInterrupt:
        print("\n[jarvis] Stopped by user.")
        return 0
    except Exception as e:
        print(f"\n[jarvis] Error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
