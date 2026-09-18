import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAudio } from "./useAudio";

const resume = vi.fn(async () => undefined);
const close = vi.fn(async () => undefined);
const oscillator = {
  connect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  frequency: { value: 0 },
  type: "sine",
};
const gain = {
  connect: vi.fn(),
  gain: {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  },
};

class AudioContextStub {
  currentTime = 1;
  destination = {};
  state: AudioContextState = "running";
  createOscillator = vi.fn(() => oscillator);
  createGain = vi.fn(() => gain);
  resume = resume;
  close = close;
}

beforeEach(() => {
  window.localStorage.clear();
  resume.mockClear();
  close.mockClear();
  oscillator.start.mockClear();
  oscillator.stop.mockClear();
  vi.stubGlobal("AudioContext", AudioContextStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAudio", () => {
  it("defaults enabled and persists toggle state", () => {
    const { result } = renderHook(() => useAudio());
    expect(result.current.soundEnabled).toBe(true);
    act(() => result.current.onSoundToggle());
    expect(result.current.soundEnabled).toBe(false);
    expect(window.localStorage.getItem("pi-sound-enabled")).toBe("false");
  });

  it("restores the stored preference", () => {
    window.localStorage.setItem("pi-sound-enabled", "false");
    const { result } = renderHook(() => useAudio());
    expect(result.current.soundEnabled).toBe(false);
  });

  it("plays the two-note completion tone only while enabled", () => {
    const { result } = renderHook(() => useAudio());
    act(() => result.current.playDoneSound());
    expect(oscillator.start).toHaveBeenCalledTimes(2);
    act(() => result.current.onSoundToggle());
    act(() => result.current.playDoneSound());
    expect(oscillator.start).toHaveBeenCalledTimes(2);
  });
});
