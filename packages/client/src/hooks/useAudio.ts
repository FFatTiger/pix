import { reportPreferenceWrite } from "@/lib/preferences/preference-sync";
import { useCallback, useEffect, useRef, useState } from "react";

const SOUND_ENABLED_KEY = "pi-sound-enabled";

function playCompletionTone(context: AudioContext): void {
  const now = context.currentTime;
  [523.25, 659.25].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const start = now + index * 0.18;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
    oscillator.start(start);
    oscillator.stop(start + 0.45);
  });
}

function readSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(SOUND_ENABLED_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

/** Completion-sound preference and shared AudioContext lifecycle. */
export function useAudio() {
  const [soundEnabled, setSoundEnabled] = useState(readSoundEnabled);

  // Server preference hydration updates the mirror in localStorage; follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SOUND_ENABLED_KEY) return;
      setSoundEnabled(event.newValue !== "false");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const enabledRef = useRef(soundEnabled);
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    enabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => () => {
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  const getContext = useCallback((): AudioContext | null => {
    const existing = contextRef.current;
    if (existing && existing.state !== "closed") return existing;
    if (typeof AudioContext === "undefined") return null;
    try {
      const context = new AudioContext();
      contextRef.current = context;
      return context;
    } catch {
      return null;
    }
  }, []);

  const unlockAudio = useCallback((force = false): void => {
    if (!force && !enabledRef.current) return;
    const context = getContext();
    if (!context || context.state !== "suspended") return;
    void context.resume().catch(() => undefined);
  }, [getContext]);

  const onSoundToggle = useCallback((): void => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    try {
      window.localStorage.setItem(SOUND_ENABLED_KEY, String(next));
    reportPreferenceWrite(SOUND_ENABLED_KEY, String(next));
    } catch {
      // Preference persistence is best-effort; the live toggle still works.
    }
    setSoundEnabled(next);
  }, [unlockAudio]);

  const playDoneSound = useCallback((): void => {
    if (!enabledRef.current) return;
    const context = getContext();
    if (!context) return;
    const play = (): void => {
      try {
        playCompletionTone(context);
      } catch {
        // Audio is an optional feedback surface.
      }
    };
    if (context.state === "suspended") {
      void context.resume().then(play).catch(() => undefined);
      return;
    }
    play();
  }, [getContext]);

  return { soundEnabled, onSoundToggle, playDoneSound, unlockAudio };
}
