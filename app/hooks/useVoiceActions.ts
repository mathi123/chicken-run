"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** `localStorage.setItem(MIC_DEBUG_STORAGE_KEY, "1")` or URL `?micDebug=1` */
export const MIC_DEBUG_STORAGE_KEY = "tok-mic-debug";

/** `?micDebug=1` or `localStorage.setItem(MIC_DEBUG_STORAGE_KEY,'1')` */
export function isMicDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(MIC_DEBUG_STORAGE_KEY) === "1") return true;
    return new URLSearchParams(window.location.search).get("micDebug") === "1";
  } catch {
    return false;
  }
}

function micLog(...args: unknown[]) {
  if (!isMicDebugEnabled()) return;
  console.info("[TokMic]", ...args);
}

export type VoiceMicStatus =
  | "idle"
  | "requesting"
  | "listening"
  | "denied"
  | "unavailable";

export type VoiceMeterState = {
  /** Smoothed RMS level (0–1, float time domain). */
  rms: number;
  /** Slow-decay peak for the meter (0–1). */
  peak: number;
  /** True while the detector thinks you are in an utterance. */
  speaking: boolean;
};

export type VoiceDetectionOptions = {
  /** RMS threshold to start counting as “speaking” (0–1). */
  openThreshold?: number;
  /** RMS must drop below this to end an utterance. */
  closeThreshold?: number;
  /** Ignore bursts shorter than this (ms). */
  minUtteranceMs?: number;
  /** Utterances at or below this length → “tok”. Above → “taaaak”. */
  shortLongBoundaryMs?: number;
  /** Ignore utterances longer than this (likely noise / yelling). */
  maxUtteranceMs?: number;
  /** Minimum gap after firing an action before another (ms). */
  cooldownMs?: number;
  /** Analyser smoothing (0–1). Lower reacts faster. */
  smoothingTimeConstant?: number;
  /** FFT size for time-domain buffer (power of two). */
  fftSize?: number;
  /**
   * When true (default), routes analyser → silent gain → destination so browsers
   * actually pull audio through the graph (otherwise the meter can stay flat).
   */
  tapDestination?: boolean;
};

const defaultDetection: Required<
  Pick<
    VoiceDetectionOptions,
    | "openThreshold"
    | "closeThreshold"
    | "minUtteranceMs"
    | "shortLongBoundaryMs"
    | "maxUtteranceMs"
    | "cooldownMs"
    | "smoothingTimeConstant"
    | "fftSize"
    | "tapDestination"
  >
> = {
  openThreshold: 0.018,
  closeThreshold: 0.009,
  minUtteranceMs: 45,
  shortLongBoundaryMs: 280,
  maxUtteranceMs: 2800,
  cooldownMs: 260,
  smoothingTimeConstant: 0.22,
  fftSize: 2048,
  tapDestination: true,
};

export type StartListeningParams = {
  /** `deviceId` from `MediaDeviceInfo.deviceId` */
  deviceId?: string;
  /**
   * When true, disables browser DSP (often louder + easier to trigger).
   * Changing this requires restarting the mic (user gesture).
   */
  rawProcessing?: boolean;
};

function rmsFloatTimeDomain(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const s = data[i];
    sum += s * s;
  }
  return Math.sqrt(sum / data.length);
}

/** Same scale-ish as float RMS; used as fallback when float buffer is flat (some embedded browsers). */
function rmsByteTimeDomain(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const s = (data[i] - 128) / 128;
    sum += s * s;
  }
  return Math.sqrt(sum / data.length);
}

/**
 * Stereo (or multi-channel) mics often put voice on one channel; summing avoids a flat analyser.
 * Multiple gains into one analyser input sum in the Web Audio spec.
 */
function connectMediaSourceToAnalyser(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
  analyser: AnalyserNode,
  log: (...args: unknown[]) => void,
) {
  const ch = source.channelCount;
  if (ch <= 1) {
    source.connect(analyser);
    log("Graph: source → analyser", { channelCount: ch });
    return;
  }
  const splitter = ctx.createChannelSplitter(ch);
  source.connect(splitter);
  const inv = 1 / ch;
  for (let i = 0; i < ch; i++) {
    const gain = ctx.createGain();
    gain.gain.value = inv;
    splitter.connect(gain, i, 0);
    gain.connect(analyser);
  }
  log("Graph: source → ChannelSplitter → gains(1/n) → analyser (summed)", { channelCount: ch });
}

function floatMinMax(data: Float32Array): { min: number; max: number } {
  let min = data[0] ?? 0;
  let max = data[0] ?? 0;
  for (let i = 1; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function pickAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function mergeDetection(options: VoiceDetectionOptions): typeof defaultDetection {
  return { ...defaultDetection, ...options };
}

/**
 * Classifies short vocal bursts as “tok” and longer sustained sounds as “taaaak”,
 * using microphone level + utterance duration (no server, no speech API).
 */
export function useVoiceActions(
  onTok: () => void,
  onTaaaak: () => void,
  options: VoiceDetectionOptions = {},
  onUtterance?: (kind: "tok" | "taaaak", durationMs: number) => void,
) {
  const detectionRef = useRef(mergeDetection(options));
  useLayoutEffect(() => {
    detectionRef.current = mergeDetection(options);
  }, [options]);

  const [status, setStatus] = useState<VoiceMicStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [meter, setMeter] = useState<VoiceMeterState>({ rms: 0, peak: 0, speaking: false });

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const byteScratchRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const speakingRef = useRef(false);
  const utterStartRef = useRef<number | null>(null);
  const lastFireRef = useRef(0);

  const onTokRef = useRef(onTok);
  const onTaaaakRef = useRef(onTaaaak);
  const onUtteranceRef = useRef(onUtterance);

  useLayoutEffect(() => {
    onTokRef.current = onTok;
    onTaaaakRef.current = onTaaaak;
    onUtteranceRef.current = onUtterance;
  }, [onTok, onTaaaak, onUtterance]);

  const rawProcessingRef = useRef(false);
  const lastMeterEmitRef = useRef(0);
  const meterSmoothRef = useRef(0);
  const meterPeakRef = useRef(0);
  const lastDebugLogRef = useRef(0);
  const loopFrameRef = useRef(0);
  const silentSamplesRef = useRef(0);
  const analyserLoopActiveRef = useRef(false);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    analyserLoopActiveRef.current = false;
    stopLoop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    dataRef.current = null;
    byteScratchRef.current = null;
    speakingRef.current = false;
    utterStartRef.current = null;
    meterSmoothRef.current = 0;
    meterPeakRef.current = 0;
    lastMeterEmitRef.current = 0;
    lastDebugLogRef.current = 0;
    loopFrameRef.current = 0;
    silentSamplesRef.current = 0;
    setMeter({ rms: 0, peak: 0, speaking: false });
  }, [stopLoop]);

  const resumeContext = useCallback(async (ctx: AudioContext) => {
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
  }, []);

  const startListening = useCallback(
    async (params: StartListeningParams = {}): Promise<boolean> => {
      setErrorMessage(null);
      setStatus("requesting");

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setErrorMessage("Microfoon is niet beschikbaar in deze browser.");
        return false;
      }

      const AudioCtx = pickAudioContextCtor();
      if (!AudioCtx) {
        setStatus("unavailable");
        setErrorMessage("Web Audio is niet beschikbaar in deze browser.");
        return false;
      }

      cleanup();
      rawProcessingRef.current = Boolean(params.rawProcessing);

      micLog("startListening()", {
        rawProcessing: rawProcessingRef.current,
        deviceId: params.deviceId ?? null,
        href: typeof window !== "undefined" ? window.location.href : "",
      });

      try {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: !rawProcessingRef.current,
          noiseSuppression: !rawProcessingRef.current,
          autoGainControl: !rawProcessingRef.current,
        };
        if (params.deviceId) {
          audioConstraints.deviceId = { ideal: params.deviceId };
        }

        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        micLog("AudioContext constructed", {
          ctor: AudioCtx.name,
          stateAfterCtor: ctx.state,
          sampleRate: ctx.sampleRate,
        });
        await resumeContext(ctx);
        micLog("after resumeContext (pre-getUserMedia)", { state: ctx.state });

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
        streamRef.current = stream;

        const tracks = stream.getAudioTracks();
        micLog("getUserMedia OK", {
          trackCount: tracks.length,
          tracks: tracks.map((t) => {
            let settings: MediaTrackSettings | Record<string, string> = {};
            try {
              settings = t.getSettings?.() ?? {};
            } catch {
              settings = { error: "getSettings failed" };
            }
            return {
              label: t.label,
              id: t.id,
              enabled: t.enabled,
              muted: t.muted,
              readyState: t.readyState,
              settings,
            };
          }),
        });

        await resumeContext(ctx);
        micLog("after resumeContext (post-stream)", { state: ctx.state });

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        const det = detectionRef.current;
        analyser.fftSize = det.fftSize;
        analyser.smoothingTimeConstant = det.smoothingTimeConstant;
        connectMediaSourceToAnalyser(ctx, source, analyser, micLog);

        micLog("MediaStreamAudioSourceNode", {
          channelCount: source.channelCount,
          numberOfOutputs: source.numberOfOutputs,
        });

        for (const t of tracks) {
          if (t.muted) {
            micLog("WARN: track.muted is true — OS or browser may not be piping audio into this graph yet.");
          }
        }

        if (det.tapDestination) {
          const sink = ctx.createGain();
          // Some engines treat gain 0 as a “dead” branch; keep output inaudible but non-zero.
          sink.gain.value = 0.0001;
          analyser.connect(sink);
          sink.connect(ctx.destination);
          micLog("Analyser → Gain(1e-4) → destination (tap)");
        } else {
          micLog("tapDestination=false (analyser NOT wired to destination)");
        }

        analyserRef.current = analyser;
        dataRef.current = new Float32Array(new ArrayBuffer(analyser.fftSize * 4)) as Float32Array<ArrayBuffer>;
        byteScratchRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize)) as Uint8Array<ArrayBuffer>;

        await resumeContext(ctx);
        micLog("final resumeContext", {
          state: ctx.state,
          fftSize: analyser.fftSize,
          openThreshold: det.openThreshold,
          closeThreshold: det.closeThreshold,
        });

        setStatus("listening");
        stopLoop();
        analyserLoopActiveRef.current = true;
        loopFrameRef.current = 0;
        silentSamplesRef.current = 0;

        const loop = () => {
          if (!analyserLoopActiveRef.current) return;

          const analyser = analyserRef.current;
          const data = dataRef.current;
          const ctxNow = audioContextRef.current;
          loopFrameRef.current += 1;

          if (!analyser || !data) {
            if (isMicDebugEnabled() && loopFrameRef.current % 120 === 0) {
              micLog("loop: analyser or buffer missing (cleanup?)", {
                hasAnalyser: Boolean(analyser),
                hasData: Boolean(data),
              });
            }
            if (analyserLoopActiveRef.current) {
              rafRef.current = requestAnimationFrame(loop);
            }
            return;
          }

          const detNow = detectionRef.current;

          analyser.getFloatTimeDomainData(data);
          const floatLevel = rmsFloatTimeDomain(data);
          const { min: fMin, max: fMax } = floatMinMax(data);

          let byteLevel = 0;
          const byteBuf = byteScratchRef.current;
          if (byteBuf && byteBuf.length === analyser.fftSize) {
            analyser.getByteTimeDomainData(byteBuf);
            byteLevel = rmsByteTimeDomain(byteBuf);
          }

          const level = Math.max(floatLevel, byteLevel);
          const now = performance.now();

          if (level < 1e-7) {
            silentSamplesRef.current += 1;
          } else {
            silentSamplesRef.current = 0;
          }

          if (isMicDebugEnabled() && now - lastDebugLogRef.current > 450) {
            lastDebugLogRef.current = now;
            const tracksNow = streamRef.current?.getAudioTracks() ?? [];
            micLog("tick", {
              frames: loopFrameRef.current,
              contextState: ctxNow?.state,
              rmsFloat: Number(floatLevel.toFixed(6)),
              rmsByte: Number(byteLevel.toFixed(6)),
              rmsUsed: Number(level.toFixed(6)),
              rmsSmooth: Number(meterSmoothRef.current.toFixed(5)),
              peak: Number(meterPeakRef.current.toFixed(5)),
              floatMin: Number(fMin.toFixed(6)),
              floatMax: Number(fMax.toFixed(6)),
              open: detNow.openThreshold,
              close: detNow.closeThreshold,
              speaking: speakingRef.current,
              tracksMuted: tracksNow.map((t) => t.muted),
              tracksReady: tracksNow.map((t) => t.readyState),
              silentStreak: silentSamplesRef.current,
            });
            if (silentSamplesRef.current > 240 && loopFrameRef.current % 180 === 0) {
              micLog(
                "warning: many consecutive near-zero buffers — try another mic, OS input level, a normal Chrome window (not embedded), or Raw-ish + Reconnect",
              );
            }
          }

          meterSmoothRef.current = meterSmoothRef.current * 0.82 + level * 0.18;
          meterPeakRef.current = Math.max(meterPeakRef.current * 0.992, meterSmoothRef.current);

          if (now - lastMeterEmitRef.current > 55) {
            lastMeterEmitRef.current = now;
            setMeter({
              rms: meterSmoothRef.current,
              peak: meterPeakRef.current,
              speaking: speakingRef.current,
            });
          }

          if (!speakingRef.current) {
            if (level >= detNow.openThreshold) {
              speakingRef.current = true;
              utterStartRef.current = now;
            }
          } else {
            if (level <= detNow.closeThreshold && utterStartRef.current != null) {
              const duration = now - utterStartRef.current;
              speakingRef.current = false;
              utterStartRef.current = null;

              if (
                duration >= detNow.minUtteranceMs &&
                duration <= detNow.maxUtteranceMs &&
                now - lastFireRef.current >= detNow.cooldownMs
              ) {
                lastFireRef.current = now;
                const kind: "tok" | "taaaak" =
                  duration <= detNow.shortLongBoundaryMs ? "tok" : "taaaak";
                if (kind === "tok") onTokRef.current();
                else onTaaaakRef.current();
                onUtteranceRef.current?.(kind, Math.round(duration));
              }
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };

        rafRef.current = requestAnimationFrame(loop);
        micLog("Analyser loop scheduled");
        return true;
      } catch (e) {
        micLog("startListening error", e);
        cleanup();
        const name = e instanceof DOMException ? e.name : "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setStatus("denied");
          setErrorMessage("Microfoontoegang is geblokkeerd. Sta de microfoon toe om met je stem te spelen.");
        } else {
          setStatus("unavailable");
          setErrorMessage("Kon de microfoon niet openen.");
        }
        return false;
      }
    },
    [cleanup, resumeContext, stopLoop],
  );

  const stopListening = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  return {
    status,
    errorMessage,
    meter,
    startListening,
    stopListening,
  };
}
