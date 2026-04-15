"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVoiceActions, type VoiceDetectionOptions } from "../hooks/useVoiceActions";

/** Visual theme for hazards — chosen from the active character when spawned. */
type ObstacleKind =
  | "chicken_hay"
  | "chicken_eggs"
  | "chicken_coop"
  | "penguin_igloo"
  | "penguin_ice"
  | "penguin_survey"
  | "flamingo_lawn"
  | "flamingo_float"
  | "flamingo_parasol"
  | "wolf_den"
  | "wolf_log"
  | "wolf_cairn";

type Obstacle = {
  /** Distance along the path where the front face of the obstacle sits. */
  at: number;
  w: number;
  h: number;
  kind: ObstacleKind;
  scored: boolean;
};

type Phase = "intro" | "calibrate" | "running" | "gameover";

const VOICE_STORAGE_KEY = "tok-chicken-voice-v1";
const CHARACTER_STORAGE_KEY = "tok-chicken-character-v1";

export type CharacterId = "chicken" | "penguin" | "flamingo" | "wolf";

const CHARACTER_COLLISION: Record<
  CharacterId,
  { top: number; left: number; right: number }
> = {
  chicken: { top: 102, left: 36, right: 40 },
  penguin: { top: 100, left: 40, right: 40 },
  flamingo: { top: 118, left: 36, right: 42 },
  wolf: { top: 108, left: 52, right: 58 },
};

function loadCharacterId(): CharacterId {
  if (typeof window === "undefined") return "chicken";
  try {
    const raw = window.localStorage.getItem(CHARACTER_STORAGE_KEY);
    if (raw === "penguin" || raw === "flamingo" || raw === "chicken" || raw === "wolf") return raw;
  } catch {
    // ignore
  }
  return "chicken";
}

type VoiceSettings = {
  sensitivity: number;
  boundaryMs: number;
  rawProcessing: boolean;
  deviceId: string;
};

const defaultVoiceSettings: VoiceSettings = {
  sensitivity: 72,
  boundaryMs: 340,
  rawProcessing: false,
  deviceId: "",
};

function loadVoiceSettings(): VoiceSettings {
  if (typeof window === "undefined") return defaultVoiceSettings;
  try {
    const raw = window.localStorage.getItem(VOICE_STORAGE_KEY);
    if (!raw) return defaultVoiceSettings;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      sensitivity: clampNum(parsed.sensitivity, 1, 100, defaultVoiceSettings.sensitivity),
      boundaryMs: clampNum(parsed.boundaryMs, 220, 560, defaultVoiceSettings.boundaryMs),
      rawProcessing: typeof parsed.rawProcessing === "boolean" ? parsed.rawProcessing : false,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
    };
  } catch {
    return defaultVoiceSettings;
  }
}

function clampNum(n: unknown, min: number, max: number, fallback: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Thresholds for float time-domain RMS from the analyser (see `useVoiceActions`). */
function sensitivityToThresholds(sensitivity: number) {
  const s = clampNum(sensitivity, 1, 100, 72);
  const open = 0.06 - (s / 100) * (0.06 - 0.0025);
  const close = Math.max(0.0012, open * 0.52);
  return { openThreshold: open, closeThreshold: close };
}

const GROUND_RATIO = 0.14;
const CHICKEN_X_RATIO = 0.2;
/** World advances when the player steps (“tok”) or jumps (“taaaak”); each bump is this many units. */
const STEP_DISTANCE = 130;
/** Horizontal travel on “taaaak” (applied at jump apex or landing) — slightly farther than a tok step. */
const JUMP_FORWARD_DISTANCE = Math.round(STEP_DISTANCE * 1.8);
const GRAVITY = 2600;
/** Upward velocity on jump — higher = bigger “taaaak” arc. */
const JUMP_VELOCITY = 1340;
const SPAWN_GAP_MIN = 420;
const SPAWN_GAP_MAX = 720;

function randBetween(a: number, b: number) {
  return a + Math.random() * (b - a);
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function pickObstacleKind(character: CharacterId): ObstacleKind {
  const r = Math.random();
  if (character === "chicken") {
    if (r < 0.34) return "chicken_hay";
    if (r < 0.67) return "chicken_eggs";
    return "chicken_coop";
  }
  if (character === "penguin") {
    if (r < 0.34) return "penguin_igloo";
    if (r < 0.67) return "penguin_ice";
    return "penguin_survey";
  }
  if (character === "flamingo") {
    if (r < 0.34) return "flamingo_lawn";
    if (r < 0.67) return "flamingo_float";
    return "flamingo_parasol";
  }
  if (character === "wolf") {
    if (r < 0.34) return "wolf_den";
    if (r < 0.67) return "wolf_log";
    return "wolf_cairn";
  }
  const _exhaustive: never = character;
  void _exhaustive;
  return "chicken_hay";
}

function obstacleWidthForKind(kind: ObstacleKind): number {
  switch (kind) {
    case "chicken_hay":
      return randBetween(52, 78);
    case "chicken_eggs":
      return randBetween(42, 58);
    case "chicken_coop":
      return randBetween(58, 88);
    case "penguin_igloo":
      return randBetween(62, 86);
    case "penguin_ice":
      return randBetween(48, 72);
    case "penguin_survey":
      return randBetween(44, 64);
    case "flamingo_lawn":
      return randBetween(34, 48);
    case "flamingo_float":
      return randBetween(56, 82);
    case "flamingo_parasol":
      return randBetween(44, 60);
    case "wolf_den":
      return randBetween(58, 82);
    case "wolf_log":
      return randBetween(64, 92);
    case "wolf_cairn":
      return randBetween(46, 68);
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return 60;
    }
  }
}

function drawThemedObstacle(
  ctx: CanvasRenderingContext2D,
  kind: ObstacleKind,
  ox: number,
  left: number,
  top: number,
  w: number,
  h: number,
  groundY: number,
) {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.1)";
  ctx.beginPath();
  ctx.ellipse(ox, groundY + 6, Math.min(w * 0.45, 70), 8, 0, 0, Math.PI * 2);
  ctx.fill();

  switch (kind) {
    case "chicken_hay": {
      const hay = ctx.createLinearGradient(left, top, left + w, groundY);
      hay.addColorStop(0, "#ffe082");
      hay.addColorStop(0.45, "#ffca28");
      hay.addColorStop(1, "#f9a825");
      ctx.fillStyle = hay;
      drawRoundedRect(ctx, left, top + 8, w, h - 8, 10);
      ctx.fill();
      ctx.strokeStyle = "rgba(180,120,40,0.35)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = top + 18 + i * ((h - 28) / 4);
        ctx.beginPath();
        ctx.moveTo(left + 6, y);
        ctx.lineTo(left + w - 6, y + 4);
        ctx.stroke();
      }
      ctx.strokeStyle = "#8d6e63";
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.arc(ox, top + 14, w * 0.35, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case "chicken_eggs": {
      const layers = Math.max(3, Math.floor(h / 36));
      for (let i = 0; i < layers; i++) {
        const t = i / Math.max(1, layers - 1);
        const ew = w * (0.55 + t * 0.35);
        const eh = Math.min(34, h / layers + 6);
        const cy = groundY - eh * 0.35 - (i * eh * 0.72);
        const grad = ctx.createRadialGradient(ox - ew * 0.2, cy - eh * 0.3, 2, ox, cy, ew);
        grad.addColorStop(0, "#fffde7");
        grad.addColorStop(0.55, "#fff9c4");
        grad.addColorStop(1, "#fdd835");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(ox, cy, ew * 0.45, eh * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(200,170,80,0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = "#8d6e63";
      ctx.beginPath();
      ctx.ellipse(ox, groundY - 6, w * 0.48, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "chicken_coop": {
      const wood = ctx.createLinearGradient(left, top, left + w, groundY);
      wood.addColorStop(0, "#d7ccc8");
      wood.addColorStop(1, "#8d6e63");
      ctx.fillStyle = wood;
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.lineTo(left + w * 0.08, top + h * 0.2);
      ctx.lineTo(ox, top);
      ctx.lineTo(left + w * 0.92, top + h * 0.2);
      ctx.lineTo(left + w, groundY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#5d4037";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 2;
      for (let x = left + 14; x < left + w - 10; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, top + h * 0.25);
        ctx.lineTo(x, groundY - 4);
        ctx.stroke();
      }
      const wx = left + w * 0.32;
      const wy = top + h * 0.38;
      const ww = w * 0.36;
      const wh = h * 0.42;
      ctx.fillStyle = "rgba(40,40,40,0.25)";
      drawRoundedRect(ctx, wx, wy, ww, wh, 6);
      ctx.fill();
      ctx.strokeStyle = "#ffecb3";
      ctx.lineWidth = 2;
      ctx.strokeRect(wx + 6, wy + 6, ww - 12, wh - 12);
      ctx.strokeStyle = "#fff59d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(wx + 8, wy + 8);
      ctx.lineTo(wx + ww - 8, wy + wh - 8);
      ctx.moveTo(wx + ww - 8, wy + 8);
      ctx.lineTo(wx + 8, wy + wh - 8);
      ctx.stroke();
      break;
    }
    case "penguin_igloo": {
      ctx.fillStyle = "#eceff1";
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.quadraticCurveTo(left, top + h * 0.15, ox - w * 0.42, top + h * 0.35);
      ctx.quadraticCurveTo(ox, top, ox + w * 0.42, top + h * 0.35);
      ctx.quadraticCurveTo(left + w, top + h * 0.15, left + w, groundY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#b0bec5";
      ctx.lineWidth = 2;
      ctx.stroke();
      const blockH = Math.min(44, h * 0.32);
      ctx.fillStyle = "#1565c0";
      drawRoundedRect(ctx, ox - w * 0.14, groundY - blockH, w * 0.28, blockH, 4);
      ctx.fill();
      ctx.fillStyle = "#0d47a1";
      ctx.fillRect(ox - w * 0.06, groundY - blockH * 0.55, w * 0.12, blockH * 0.55);
      for (let i = 0; i < 3; i++) {
        const sx = ox - w * 0.32 + i * w * 0.22;
        const sy = top + h * (0.22 + i * 0.08);
        ctx.fillStyle = "rgba(100,120,140,0.35)";
        ctx.fillRect(sx, sy, w * 0.1, 8);
      }
      break;
    }
    case "penguin_ice": {
      const rows = 3;
      const brickH = (h - 10) / rows;
      for (let row = 0; row < rows; row++) {
        const offset = row % 2 === 0 ? 0 : w * 0.12;
        const cols = 2;
        for (let c = 0; c < cols; c++) {
          const bw = w * 0.48;
          const bx = left + offset + c * (bw * 0.92);
          const by = top + 6 + row * brickH;
          const ice = ctx.createLinearGradient(bx, by, bx + bw, by + brickH);
          ice.addColorStop(0, "#e1f5fe");
          ice.addColorStop(0.5, "#81d4fa");
          ice.addColorStop(1, "#4fc3f7");
          ctx.fillStyle = ice;
          drawRoundedRect(ctx, bx, by, bw - 4, brickH - 4, 6);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,0.45)";
          ctx.fillRect(bx + 8, by + 6, bw * 0.25, 4);
        }
      }
      break;
    }
    case "penguin_survey": {
      ctx.fillStyle = "#eceff1";
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.quadraticCurveTo(ox, top + h * 0.35, left + w, groundY);
      ctx.closePath();
      ctx.fill();
      const colors = ["#e53935", "#fbc02d", "#43a047"] as const;
      for (let i = 0; i < 3; i++) {
        const px = left + w * (0.22 + i * 0.28);
        ctx.strokeStyle = "#78909c";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(px, groundY);
        ctx.lineTo(px, top + h * (0.25 + i * 0.06));
        ctx.stroke();
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.moveTo(px, top + h * (0.25 + i * 0.06));
        ctx.lineTo(px - 10, top + h * (0.38 + i * 0.06));
        ctx.lineTo(px + 10, top + h * (0.38 + i * 0.06));
        ctx.closePath();
        ctx.fill();
      }
      const bx = ox - w * 0.22;
      const by = top + h * 0.42;
      const bw = w * 0.44;
      const bh = h * 0.38;
      ctx.fillStyle = "#fafafa";
      drawRoundedRect(ctx, bx, by, bw, bh, 6);
      ctx.fill();
      ctx.strokeStyle = "#90a4ae";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = "#37474f";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(bx + 10, by + bh * 0.45);
      ctx.lineTo(bx + 16, by + bh * 0.55);
      ctx.lineTo(bx + 28, by + bh * 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx + 22, by + bh * 0.62);
      ctx.lineTo(bx + 34, by + bh * 0.72);
      ctx.lineTo(bx + 46, by + bh * 0.52);
      ctx.stroke();
      ctx.fillStyle = "#263238";
      ctx.fillRect(bx + bw - 14, by + 6, 6, 10);
      break;
    }
    case "flamingo_lawn": {
      ctx.strokeStyle = "#ad1457";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(ox, groundY);
      ctx.lineTo(ox + 4, top + h * 0.72);
      ctx.stroke();
      ctx.strokeStyle = "#c2185b";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(ox + 4, top + h * 0.72);
      ctx.quadraticCurveTo(ox + w * 0.35, top + h * 0.35, ox + w * 0.15, top + h * 0.12);
      ctx.stroke();
      ctx.fillStyle = "#ec407a";
      ctx.beginPath();
      ctx.ellipse(ox + w * 0.2, top + h * 0.14, w * 0.22, h * 0.12, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#212121";
      ctx.beginPath();
      ctx.moveTo(ox + w * 0.34, top + h * 0.1);
      ctx.lineTo(ox + w * 0.52, top + h * 0.11);
      ctx.lineTo(ox + w * 0.32, top + h * 0.16);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fce4ec";
      ctx.beginPath();
      ctx.arc(ox + w * 0.08, top + h * 0.18, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "flamingo_float": {
      const ring = ctx.createLinearGradient(left, top, left + w, groundY);
      ring.addColorStop(0, "#f48fb1");
      ring.addColorStop(0.5, "#ec407a");
      ring.addColorStop(1, "#ad1457");
      ctx.fillStyle = ring;
      drawRoundedRect(ctx, left, top + h * 0.12, w, h * 0.88, Math.min(28, w * 0.35));
      ctx.fill();
      ctx.fillStyle = "#fce4ec";
      ctx.beginPath();
      ctx.ellipse(ox, top + h * 0.35, w * 0.28, h * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(left + 12 + i * 18, top + h * 0.55, 10, 5);
      }
      break;
    }
    case "flamingo_parasol": {
      const glass = ctx.createLinearGradient(left, top, left + w, groundY);
      glass.addColorStop(0, "rgba(255,255,255,0.92)");
      glass.addColorStop(1, "rgba(255,183,213,0.45)");
      ctx.fillStyle = glass;
      ctx.beginPath();
      ctx.moveTo(left + w * 0.12, groundY);
      ctx.lineTo(left + w * 0.22, top + h * 0.25);
      ctx.lineTo(left + w * 0.78, top + h * 0.25);
      ctx.lineTo(left + w * 0.88, groundY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(236,64,122,0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#aed581";
      ctx.beginPath();
      ctx.arc(ox, top + h * 0.52, w * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#f06292";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ox, top + h * 0.28);
      ctx.lineTo(ox, top + h * 0.08);
      ctx.stroke();
      ctx.fillStyle = "#f48fb1";
      ctx.beginPath();
      ctx.moveTo(ox, top + h * 0.08);
      ctx.lineTo(left + 4, top + h * 0.22);
      ctx.quadraticCurveTo(ox, top - h * 0.02, left + w - 4, top + h * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#ec407a";
      ctx.lineWidth = 2;
      ctx.stroke();
      break;
    }
    case "wolf_den": {
      const rock = ctx.createLinearGradient(left, top, left + w, groundY);
      rock.addColorStop(0, "#78909c");
      rock.addColorStop(0.5, "#546e7a");
      rock.addColorStop(1, "#37474f");
      ctx.fillStyle = rock;
      ctx.beginPath();
      ctx.moveTo(left, groundY);
      ctx.lineTo(left + w * 0.08, top + h * 0.35);
      ctx.lineTo(left + w * 0.22, top + h * 0.12);
      ctx.lineTo(left + w * 0.78, top + h * 0.12);
      ctx.lineTo(left + w * 0.92, top + h * 0.35);
      ctx.lineTo(left + w, groundY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#455a64";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "rgba(20,24,32,0.92)";
      ctx.beginPath();
      ctx.moveTo(left + w * 0.28, groundY - 8);
      ctx.lineTo(left + w * 0.32, top + h * 0.28);
      ctx.quadraticCurveTo(ox, top + h * 0.08, left + w * 0.68, top + h * 0.28);
      ctx.lineTo(left + w * 0.72, groundY - 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(129,199,132,0.5)";
      ctx.beginPath();
      ctx.ellipse(ox - w * 0.25, top + h * 0.18, w * 0.12, 6, 0, 0, Math.PI * 2);
      ctx.ellipse(ox + w * 0.22, top + h * 0.22, w * 0.1, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "wolf_log": {
      const bark = ctx.createLinearGradient(left, top, left + w, top + h);
      bark.addColorStop(0, "#6d4c41");
      bark.addColorStop(0.4, "#5d4037");
      bark.addColorStop(1, "#3e2723");
      ctx.fillStyle = bark;
      drawRoundedRect(ctx, left, top + h * 0.15, w, h * 0.7, Math.min(22, h * 0.2));
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const lx = left + 12 + i * (w / 6);
        ctx.beginPath();
        ctx.moveTo(lx, top + h * 0.2);
        ctx.lineTo(lx + 4, top + h * 0.82);
        ctx.stroke();
      }
      ctx.fillStyle = "#d7ccc8";
      ctx.beginPath();
      ctx.ellipse(left + 8, top + h * 0.5, 10, h * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.lineWidth = 2;
      ctx.stroke();
      for (let r = 0; r < 4; r++) {
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        ctx.beginPath();
        ctx.arc(left + 8, top + h * 0.5, 8 - r * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case "wolf_cairn": {
      const stones = [
        { cx: 0.5, cy: 0.75, rw: 0.42, rh: 0.22 },
        { cx: 0.35, cy: 0.52, rw: 0.32, rh: 0.2 },
        { cx: 0.62, cy: 0.48, rw: 0.28, rh: 0.18 },
        { cx: 0.48, cy: 0.28, rw: 0.22, rh: 0.14 },
      ] as const;
      for (const s of stones) {
        const sx = left + w * s.cx;
        const sy = top + h * s.cy;
        const rw = w * s.rw;
        const rh = h * s.rh;
        const g = ctx.createRadialGradient(sx - rw * 0.2, sy - rh * 0.3, 2, sx, sy, rw);
        g.addColorStop(0, "#cfd8dc");
        g.addColorStop(0.55, "#90a4ae");
        g.addColorStop(1, "#546e7a");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(sx, sy, rw * 0.5, rh, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,249,196,0.95)";
      ctx.beginPath();
      ctx.arc(ox + w * 0.08, top + h * 0.12, Math.min(9, w * 0.1), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,241,118,0.5)";
      ctx.beginPath();
      ctx.arc(ox + w * 0.14, top + h * 0.1, 4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: {
      const _k: never = kind;
      void _k;
      break;
    }
  }

  ctx.restore();
}

/** `footY` is the canvas y-coordinate where the feet meet the ground. */
function drawChicken(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  scale: number,
  flap: number,
) {
  ctx.save();
  ctx.translate(cx, footY - 52 * scale);
  ctx.scale(scale, scale);
  ctx.rotate(Math.sin(flap) * 0.12);

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.ellipse(0, 38, 34, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  const bodyGrad = ctx.createLinearGradient(-40, -20, 40, 40);
  bodyGrad.addColorStop(0, "#ffd54f");
  bodyGrad.addColorStop(1, "#ff9800");
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(0, 5, 42, 36, 0, 0, Math.PI * 2);
  ctx.fill();

  // wing
  ctx.fillStyle = "#ffe082";
  ctx.beginPath();
  ctx.ellipse(-18, 8 + Math.sin(flap * 2) * 4, 22, 14, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.fillStyle = "#fff3bf";
  ctx.beginPath();
  ctx.arc(28, -18, 26, 0, Math.PI * 2);
  ctx.fill();

  // comb
  ctx.fillStyle = "#ff5252";
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(22 + i * 10, -40, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  // beak
  ctx.fillStyle = "#ffb300";
  ctx.beginPath();
  ctx.moveTo(52, -14);
  ctx.lineTo(78, -8);
  ctx.lineTo(52, -2);
  ctx.closePath();
  ctx.fill();

  // eye
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(36, -22, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#263238";
  ctx.beginPath();
  ctx.arc(39, -22, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(40, -24, 2, 0, Math.PI * 2);
  ctx.fill();

  // legs
  ctx.strokeStyle = "#ff7043";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-8, 36);
  ctx.lineTo(-10, 52);
  ctx.moveTo(10, 36);
  ctx.lineTo(12, 52);
  ctx.stroke();

  ctx.restore();
}

/** Feet anchor: local feet sit at y = 52 after translate. */
function drawPenguin(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  scale: number,
  flap: number,
) {
  const wobble = Math.sin(flap * 2) * 3;
  const flip = Math.sin(flap) * 0.08;

  ctx.save();
  ctx.translate(cx, footY - 52 * scale);
  ctx.scale(scale, scale);
  ctx.rotate(flip);

  // ground shadow
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.beginPath();
  ctx.ellipse(2, 48, 28, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- black “tux” body (back + sides) ---
  const bodyGrad = ctx.createLinearGradient(-32, -28, 32, 44);
  bodyGrad.addColorStop(0, "#1a1a1a");
  bodyGrad.addColorStop(0.45, "#263238");
  bodyGrad.addColorStop(1, "#101010");
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(0, 6, 34, 38, 0, 0, Math.PI * 2);
  ctx.fill();

  // white belly shield (classic inverted U)
  ctx.fillStyle = "#fafafa";
  ctx.beginPath();
  ctx.moveTo(0, -18);
  ctx.bezierCurveTo(22, -12, 24, 8, 20, 36);
  ctx.bezierCurveTo(12, 44, -12, 44, -20, 36);
  ctx.bezierCurveTo(-24, 8, -22, -12, 0, -18);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // dark side panels over belly (tux jacket look)
  ctx.fillStyle = "#212121";
  ctx.beginPath();
  ctx.moveTo(-30, -8);
  ctx.quadraticCurveTo(-34, 18, -22, 42);
  ctx.lineTo(-8, 40);
  ctx.quadraticCurveTo(-20, 12, -18, -14);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(30, -8);
  ctx.quadraticCurveTo(34, 18, 22, 42);
  ctx.lineTo(8, 40);
  ctx.quadraticCurveTo(20, 12, 18, -14);
  ctx.closePath();
  ctx.fill();

  // flippers (wing-shaped, not ovals)
  ctx.fillStyle = "#1e272e";
  ctx.beginPath();
  ctx.moveTo(-32, -2 + wobble);
  ctx.quadraticCurveTo(-48, 14, -40, 34);
  ctx.quadraticCurveTo(-28, 30, -24, 12);
  ctx.quadraticCurveTo(-26, 0, -32, -2 + wobble);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(32, -2 - wobble);
  ctx.quadraticCurveTo(48, 14, 40, 34);
  ctx.quadraticCurveTo(28, 30, 24, 12);
  ctx.quadraticCurveTo(26, 0, 32, -2 - wobble);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // head (black dome)
  ctx.fillStyle = "#263238";
  ctx.beginPath();
  ctx.arc(0, -22, 22, Math.PI, 0);
  ctx.lineTo(18, -8);
  ctx.quadraticCurveTo(0, -2, -18, -8);
  ctx.closePath();
  ctx.fill();

  // white face mask
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.ellipse(4, -20, 20, 18, 0.15, 0, Math.PI * 2);
  ctx.fill();

  // blush
  ctx.fillStyle = "rgba(255, 182, 193, 0.65)";
  ctx.beginPath();
  ctx.ellipse(-8, -16, 4, 2.5, 0, 0, Math.PI * 2);
  ctx.ellipse(14, -15, 4, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // eyes
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(-2, -22, 7, 0, Math.PI * 2);
  ctx.arc(12, -21, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0d1117";
  ctx.beginPath();
  ctx.arc(0, -21, 3.2, 0, Math.PI * 2);
  ctx.arc(13, -20, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(1, -22, 1.3, 0, Math.PI * 2);
  ctx.arc(14, -21, 1.3, 0, Math.PI * 2);
  ctx.fill();

  // beak (upper + lower like a real penguin bill)
  ctx.fillStyle = "#ff6f00";
  ctx.beginPath();
  ctx.moveTo(22, -18);
  ctx.quadraticCurveTo(38, -14, 34, -8);
  ctx.lineTo(24, -10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffa040";
  ctx.beginPath();
  ctx.moveTo(22, -10);
  ctx.quadraticCurveTo(32, -6, 28, -2);
  ctx.lineTo(20, -6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(22, -14);
  ctx.quadraticCurveTo(30, -12, 28, -8);
  ctx.stroke();

  // webbed feet
  ctx.fillStyle = "#ff7043";
  const drawFoot = (fx: number, fy: number, mirror: number) => {
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.quadraticCurveTo(fx + 10 * mirror, fy + 4, fx + 12 * mirror, fy + 14);
    ctx.quadraticCurveTo(fx + 6 * mirror, fy + 12, fx, fy + 10);
    ctx.quadraticCurveTo(fx - 6 * mirror, fy + 12, fx - 12 * mirror, fy + 14);
    ctx.quadraticCurveTo(fx - 10 * mirror, fy + 4, fx, fy);
    ctx.closePath();
    ctx.fill();
  };
  drawFoot(-12, 44, 1);
  drawFoot(14, 44, -1);

  ctx.restore();
}

/** Feet anchor: local feet sit at y = 62 after translate. */
function drawFlamingo(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  scale: number,
  flap: number,
) {
  ctx.save();
  ctx.translate(cx, footY - 62 * scale);
  ctx.scale(scale, scale);
  ctx.rotate(Math.sin(flap) * 0.05);

  ctx.fillStyle = "rgba(0,0,0,0.1)";
  ctx.beginPath();
  ctx.ellipse(6, 50, 22, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#f48fb1";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-2, 26);
  ctx.lineTo(-4, 60);
  ctx.moveTo(10, 26);
  ctx.lineTo(14, 60);
  ctx.stroke();

  const bodyGrad = ctx.createLinearGradient(-18, -8, 32, 36);
  bodyGrad.addColorStop(0, "#fce4ec");
  bodyGrad.addColorStop(0.5, "#f8bbd9");
  bodyGrad.addColorStop(1, "#ec407a");
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(2, 6, 30, 30, -0.12, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#f06292";
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(10, -2);
  ctx.quadraticCurveTo(26, -32, 22, -54);
  ctx.stroke();

  ctx.fillStyle = "#fce4ec";
  ctx.beginPath();
  ctx.arc(22, -58, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#37474f";
  ctx.beginPath();
  ctx.moveTo(32, -56);
  ctx.lineTo(46, -50);
  ctx.lineTo(34, -46);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#f06292";
  ctx.beginPath();
  ctx.ellipse(-8, 2 + Math.sin(flap * 2) * 3, 17, 11, 0.25, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(18, -60, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#212121";
  ctx.beginPath();
  ctx.arc(19, -60, 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Feet anchor: local paws sit near y ≈ 54 after translate. */
function drawWolf(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  scale: number,
  flap: number,
) {
  const ear = Math.sin(flap * 2) * 2;
  ctx.save();
  ctx.translate(cx, footY - 56 * scale);
  ctx.scale(scale, scale);
  ctx.rotate(Math.sin(flap) * 0.08);

  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.beginPath();
  ctx.ellipse(4, 52, 34, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // bushy tail
  ctx.fillStyle = "#37474f";
  ctx.beginPath();
  ctx.moveTo(-22, 18);
  ctx.quadraticCurveTo(-48, 10 + ear, -52, -12);
  ctx.quadraticCurveTo(-38, -18, -26, -6);
  ctx.quadraticCurveTo(-20, 6, -22, 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.moveTo(-30, 4);
  ctx.quadraticCurveTo(-44, -2, -40, -10);
  ctx.quadraticCurveTo(-34, -6, -28, 2);
  ctx.closePath();
  ctx.fill();

  // body
  const fur = ctx.createLinearGradient(-36, -24, 44, 52);
  fur.addColorStop(0, "#607d8b");
  fur.addColorStop(0.45, "#455a64");
  fur.addColorStop(1, "#263238");
  ctx.fillStyle = fur;
  ctx.beginPath();
  ctx.ellipse(2, 8, 38, 36, 0, 0, Math.PI * 2);
  ctx.fill();

  // lighter chest
  ctx.fillStyle = "#90a4ae";
  ctx.beginPath();
  ctx.ellipse(16, 10, 22, 26, 0.35, 0, Math.PI * 2);
  ctx.fill();

  // front leg
  ctx.strokeStyle = "#263238";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(14, 32);
  ctx.lineTo(18, 54);
  ctx.moveTo(-6, 34);
  ctx.lineTo(-10, 54);
  ctx.stroke();

  // paws
  ctx.fillStyle = "#37474f";
  ctx.beginPath();
  ctx.ellipse(18, 56, 10, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(-10, 56, 10, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // head
  ctx.fillStyle = "#455a64";
  ctx.beginPath();
  ctx.ellipse(30, -12, 24, 22, 0.15, 0, Math.PI * 2);
  ctx.fill();

  // ears
  ctx.fillStyle = "#37474f";
  ctx.beginPath();
  ctx.moveTo(14, -28 + ear);
  ctx.lineTo(22, -48 + ear);
  ctx.lineTo(30, -26 + ear);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(34, -26 + ear);
  ctx.lineTo(44, -44 + ear);
  ctx.lineTo(48, -22 + ear);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.moveTo(18, -32 + ear);
  ctx.lineTo(22, -42 + ear);
  ctx.lineTo(26, -30 + ear);
  ctx.closePath();
  ctx.fill();

  // snout block
  ctx.fillStyle = "#546e7a";
  ctx.beginPath();
  ctx.moveTo(44, -8);
  ctx.lineTo(62, -4);
  ctx.lineTo(58, 6);
  ctx.lineTo(40, 4);
  ctx.closePath();
  ctx.fill();

  // nose
  ctx.fillStyle = "#212121";
  ctx.beginPath();
  ctx.ellipse(58, -2, 5, 4, 0.3, 0, Math.PI * 2);
  ctx.fill();

  // eyes (warm amber)
  ctx.fillStyle = "#fff8e1";
  ctx.beginPath();
  ctx.ellipse(36, -16, 7, 8, 0.1, 0, Math.PI * 2);
  ctx.ellipse(48, -14, 6, 7, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff8f00";
  ctx.beginPath();
  ctx.ellipse(37, -15, 3.5, 4.5, 0.1, 0, Math.PI * 2);
  ctx.ellipse(49, -13, 3, 4, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(38, -14, 1.8, 0, Math.PI * 2);
  ctx.arc(50, -12.5, 1.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  cx: number,
  footY: number,
  scale: number,
  flap: number,
  id: CharacterId,
) {
  if (id === "penguin") drawPenguin(ctx, cx, footY, scale, flap);
  else if (id === "flamingo") drawFlamingo(ctx, cx, footY, scale, flap);
  else if (id === "wolf") drawWolf(ctx, cx, footY, scale, flap);
  else drawChicken(ctx, cx, footY, scale, flap);
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  const blobs = [
    [0, 0, 40],
    [35, -6, 36],
    [68, 2, 32],
    [30, 14, 38],
  ];
  for (const [bx, by, r] of blobs) {
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function ChickenRunGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const phaseRef = useRef(phase);

  /** Default on server + first client paint so SSR HTML matches hydration (LS hydrated in useEffect). */
  const [character, setCharacter] = useState<CharacterId>("chicken");
  const characterRef = useRef(character);

  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const lastScoreRef = useRef(0);

  const [voice, setVoice] = useState<VoiceSettings>(defaultVoiceSettings);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [testLog, setTestLog] = useState<{ kind: "tok" | "taaaak"; ms: number; at: number }[]>([]);
  const [calibrateMoreOpen, setCalibrateMoreOpen] = useState(false);

  const skipInitialVoicePersistRef = useRef(true);
  const skipInitialCharacterPersistRef = useRef(true);

  useEffect(() => {
    startTransition(() => {
      setCharacter(loadCharacterId());
      setVoice(loadVoiceSettings());
    });
  }, []);

  useEffect(() => {
    if (skipInitialVoicePersistRef.current) {
      skipInitialVoicePersistRef.current = false;
      return;
    }
    try {
      window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(voice));
    } catch {
      // ignore
    }
  }, [voice]);

  useEffect(() => {
    if (skipInitialCharacterPersistRef.current) {
      skipInitialCharacterPersistRef.current = false;
      return;
    }
    try {
      window.localStorage.setItem(CHARACTER_STORAGE_KEY, character);
    } catch {
      // ignore
    }
  }, [character]);

  const onUtteranceLog = useCallback((kind: "tok" | "taaaak", durationMs: number) => {
    if (phaseRef.current !== "calibrate") return;
    setTestLog((prev) => [{ kind, ms: durationMs, at: Date.now() }, ...prev].slice(0, 10));
  }, []);

  const gameRef = useRef({
    distance: 0,
    /** Feet baseline (canvas y, downward positive). */
    chickenY: 0,
    /** Upward velocity in px/s (positive = moving up on screen). */
    chickenVy: 0,
    obstacles: [] as Obstacle[],
    nextSpawnAt: 520,
    flap: 0,
    alive: true,
    /** Seconds of “step dust” after a tok (visual only). */
    stepFlash: 0,
    /** Forward distance to add once the jump reaches its apex (see game loop). */
    jumpForwardPending: 0,
    width: 800,
    height: 600,
    groundY: 80,
    chickenX: 160,
    lastTs: 0,
  });

  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 700);
  }, []);

  const resetRun = useCallback(() => {
    const g = gameRef.current;
    g.distance = 0;
    g.stepFlash = 0;
    g.jumpForwardPending = 0;
    g.chickenVy = 0;
    g.obstacles = [];
    g.nextSpawnAt = 520;
    g.alive = true;
    g.flap = 0;
    g.lastTs = 0;
    lastScoreRef.current = 0;
    setScore(0);
    const groundY = g.height * (1 - GROUND_RATIO);
    g.groundY = groundY;
    g.chickenY = groundY;
  }, []);

  const bumpTok = useCallback(() => {
    const g = gameRef.current;
    if (!g.alive || phaseRef.current !== "running") return;
    g.distance += STEP_DISTANCE;
    g.stepFlash = 0.32;
    const nextScore = Math.floor(g.distance / 10);
    if (nextScore !== lastScoreRef.current) {
      lastScoreRef.current = nextScore;
      setScore(nextScore);
    }
    showToast("Tok! Stap!");
  }, [showToast]);

  const doJump = useCallback(() => {
    const g = gameRef.current;
    if (!g.alive || phaseRef.current !== "running") return;
    const onGround = g.chickenY >= g.groundY - 3;
    if (onGround) {
      g.chickenVy = JUMP_VELOCITY;
      g.jumpForwardPending = JUMP_FORWARD_DISTANCE;
      showToast("Taaaak! Sprong!");
    }
  }, [showToast]);

  const voiceDetectionOptions: VoiceDetectionOptions = useMemo(() => {
    const { openThreshold, closeThreshold } = sensitivityToThresholds(voice.sensitivity);
    return {
      openThreshold,
      closeThreshold,
      shortLongBoundaryMs: voice.boundaryMs,
      minUtteranceMs: 45,
      cooldownMs: 240,
      smoothingTimeConstant: 0.22,
      fftSize: 2048,
      tapDestination: true,
    };
  }, [voice.sensitivity, voice.boundaryMs]);

  const { status, errorMessage, meter, startListening, stopListening } = useVoiceActions(
    bumpTok,
    doJump,
    voiceDetectionOptions,
    onUtteranceLog,
  );

  useEffect(() => {
    if (status !== "listening") return;
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => setMicDevices(list.filter((d) => d.kind === "audioinput")))
      .catch(() => setMicDevices([]));
  }, [status]);

  const openMicForCalibration = useCallback(async () => {
    const ok = await startListening({
      deviceId: voice.deviceId || undefined,
      rawProcessing: voice.rawProcessing,
    });
    if (!ok) setMicDevices([]);
  }, [startListening, voice.deviceId, voice.rawProcessing]);

  const reconnectMic = useCallback(async () => {
    stopListening();
    await new Promise((r) => window.setTimeout(r, 60));
    await startListening({
      deviceId: voice.deviceId || undefined,
      rawProcessing: voice.rawProcessing,
    });
  }, [startListening, stopListening, voice.deviceId, voice.rawProcessing]);

  const beginGameFromCalibration = useCallback(() => {
    resetRun();
    setPhase("running");
  }, [resetRun]);

  const goToCalibration = useCallback(() => {
    stopListening();
    setTestLog([]);
    setCalibrateMoreOpen(false);
    setPhase("calibrate");
  }, [stopListening]);

  const playAgain = useCallback(async () => {
    setTestLog([]);
    resetRun();
    const ok = await startListening({
      deviceId: voice.deviceId || undefined,
      rawProcessing: voice.rawProcessing,
    });
    if (ok) setPhase("running");
  }, [resetRun, startListening, voice.deviceId, voice.rawProcessing]);

  const endRun = useCallback(() => {
    stopListening();
    setPhase("gameover");
    setBest((b) => Math.max(b, Math.floor(gameRef.current.distance / 10)));
  }, [stopListening]);

  const endRunRef = useRef(endRun);

  useLayoutEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useLayoutEffect(() => {
    characterRef.current = character;
  }, [character]);

  useLayoutEffect(() => {
    endRunRef.current = endRun;
  }, [endRun]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const readSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vv = window.visualViewport;
      const w = Math.max(1, Math.floor(vv?.width ?? window.innerWidth));
      const h = Math.max(1, Math.floor(vv?.height ?? window.innerHeight));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = gameRef.current;
      g.width = w;
      g.height = h;
      g.groundY = h * (1 - GROUND_RATIO);
      g.chickenX = w * CHICKEN_X_RATIO;
      if (
        phaseRef.current === "intro" ||
        phaseRef.current === "calibrate" ||
        phaseRef.current === "gameover"
      ) {
        g.chickenY = g.groundY;
        g.chickenVy = 0;
        g.jumpForwardPending = 0;
      }
    };
    readSize();
    const ro = new ResizeObserver(readSize);
    const roTarget = canvas.parentElement ?? canvas;
    ro.observe(roTarget);
    window.addEventListener("resize", readSize);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", readSize);
    vv?.addEventListener("scroll", readSize);

    let raf = 0;
    const loop = (ts: number) => {
      const g = gameRef.current;
      if (!g.lastTs) g.lastTs = ts;
      const dt = Math.min(32, ts - g.lastTs) / 1000;
      g.lastTs = ts;

      const w = g.width;
      const h = g.height;
      const groundY = g.groundY;

      if (phaseRef.current === "running" && g.alive) {
        if (g.stepFlash > 0) {
          g.stepFlash = Math.max(0, g.stepFlash - dt);
        }

        const vyBefore = g.chickenVy;
        g.chickenVy -= GRAVITY * dt;
        if (
          g.jumpForwardPending > 0 &&
          vyBefore > 0 &&
          g.chickenVy <= 0
        ) {
          g.distance += g.jumpForwardPending;
          g.jumpForwardPending = 0;
          g.stepFlash = 0.28;
          const nextScore = Math.floor(g.distance / 10);
          if (nextScore !== lastScoreRef.current) {
            lastScoreRef.current = nextScore;
            setScore(nextScore);
          }
        }
        g.chickenY -= g.chickenVy * dt;
        if (g.chickenY >= groundY) {
          g.chickenY = groundY;
          if (g.jumpForwardPending > 0) {
            g.distance += g.jumpForwardPending;
            g.jumpForwardPending = 0;
            g.stepFlash = 0.28;
            const nextScore = Math.floor(g.distance / 10);
            if (nextScore !== lastScoreRef.current) {
              lastScoreRef.current = nextScore;
              setScore(nextScore);
            }
          }
          g.chickenVy = 0;
        }

        while (g.distance + w * 1.6 > g.nextSpawnAt) {
          const tall = randBetween(0.14, 0.22) * h;
          const kind = pickObstacleKind(characterRef.current);
          g.obstacles.push({
            at: g.nextSpawnAt,
            w: obstacleWidthForKind(kind),
            h: tall,
            kind,
            scored: false,
          });
          g.nextSpawnAt += randBetween(SPAWN_GAP_MIN, SPAWN_GAP_MAX);
        }

        const hb = CHARACTER_COLLISION[characterRef.current];
        const chickenLeft = g.chickenX - hb.left;
        const chickenRight = g.chickenX + hb.right;
        const chickenTop = g.chickenY - hb.top;
        const chickenBottom = g.chickenY;

        for (const o of g.obstacles) {
          const ox = o.at - g.distance + g.chickenX;
          const obstacleLeft = ox - o.w / 2;
          const obstacleRight = ox + o.w / 2;
          const obstacleTop = groundY - o.h;

          const hit =
            chickenRight > obstacleLeft &&
            chickenLeft < obstacleRight &&
            chickenBottom > obstacleTop &&
            chickenTop < groundY;

          if (hit && g.alive) {
            g.alive = false;
            endRunRef.current();
            break;
          }

          if (!o.scored && obstacleRight < chickenLeft) {
            o.scored = true;
          }
        }

        g.obstacles = g.obstacles.filter((o) => o.at - g.distance > -200);
      }

      g.flap += dt * 14;

      // --- draw ---
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#7ecbff");
      sky.addColorStop(0.45, "#b3e5ff");
      sky.addColorStop(1, "#e1f8ff");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // distant hills
      ctx.fillStyle = "#81c784";
      ctx.beginPath();
      ctx.moveTo(0, groundY + 40);
      for (let x = 0; x <= w + 80; x += 80) {
        ctx.lineTo(
          x,
          groundY - 30 + Math.sin((x + g.distance * 0.08) * 0.02) * 26,
        );
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#a5d6a7";
      ctx.beginPath();
      ctx.moveTo(0, groundY + 20);
      for (let x = 0; x <= w + 60; x += 60) {
        ctx.lineTo(
          x,
          groundY + 10 + Math.sin((x + g.distance * 0.12) * 0.025) * 18,
        );
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      // clouds
      drawCloud(ctx, (w * 0.15 - (g.distance * 0.04) % (w + 200)) + 40, h * 0.18, 1);
      drawCloud(ctx, (w * 0.55 - (g.distance * 0.07) % (w + 260)) + 120, h * 0.12, 0.85);
      drawCloud(ctx, (w * 0.82 - (g.distance * 0.05) % (w + 220)) + 200, h * 0.22, 0.75);

      // ground
      const grass = ctx.createLinearGradient(0, groundY - 40, 0, h);
      grass.addColorStop(0, "#9ccc65");
      grass.addColorStop(0.4, "#7cb342");
      grass.addColorStop(1, "#558b2f");
      ctx.fillStyle = grass;
      ctx.fillRect(0, groundY - 6, w, h - groundY + 6);

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 3;
      for (let x = (-g.distance * 1.2) % 40; x < w + 40; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, groundY + 4);
        ctx.quadraticCurveTo(x + 20, groundY - 2, x + 40, groundY + 4);
        ctx.stroke();
      }

      // obstacles (theme matches selected character at spawn time)
      for (const o of g.obstacles) {
        const ox = o.at - g.distance + g.chickenX;
        const left = ox - o.w / 2;
        const top = groundY - o.h;
        drawThemedObstacle(ctx, o.kind, ox, left, top, o.w, o.h, groundY);
      }

      drawPlayer(ctx, g.chickenX, g.chickenY, 1, g.flap, characterRef.current);

      // sparkle burst after a step (“tok”)
      if (g.stepFlash > 0 && phaseRef.current === "running") {
        for (let i = 0; i < 5; i++) {
          const t = (ts / 1000 + i * 0.4) % 1;
          ctx.fillStyle = `rgba(255,235,59,${1 - t})`;
          ctx.beginPath();
          ctx.arc(g.chickenX - 50 - t * 120, g.chickenY - 20 + i * 6, 6 * (1 - t), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", readSize);
      vv?.removeEventListener("resize", readSize);
      vv?.removeEventListener("scroll", readSize);
    };
  }, []);

  const micOn = status === "listening";
  const { openThreshold, closeThreshold } = sensitivityToThresholds(voice.sensitivity);
  const meterScale = 0.045;
  const meterPct = Math.min(100, (meter.rms / meterScale) * 100);
  const peakPct = Math.min(100, (meter.peak / meterScale) * 100);
  const openPct = Math.min(100, (openThreshold / meterScale) * 100);
  const closePct = Math.min(100, (closeThreshold / meterScale) * 100);

  return (
    <div className="relative min-h-dvh h-dvh w-full overflow-hidden bg-[#7ecbff] font-sans text-slate-900 select-none touch-manipulation">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block size-full touch-none"
        aria-label="Speelveld stemrun"
      />

      {/* HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between gap-3 p-4 pt-[max(0.75rem,env(safe-area-inset-top,0px))]">
        <div className="rounded-2xl bg-white/85 px-4 py-2 shadow-lg backdrop-blur-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Punten</p>
          <p className="text-2xl font-black tabular-nums text-amber-600">{score}</p>
        </div>
        <div className="rounded-2xl bg-white/85 px-4 py-2 text-right shadow-lg backdrop-blur-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Record</p>
          <p className="text-2xl font-black tabular-nums text-sky-600">{best}</p>
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none absolute left-1/2 top-[5.75rem] z-20 -translate-x-1/2 rounded-full bg-amber-300 px-5 py-2 text-sm font-bold text-amber-950 shadow-lg ring-2 ring-amber-100 md:top-28">
          {toast}
        </div>
      )}

      {/* Mic pill */}
      {(phase === "running" || phase === "calibrate") && (
        <div className="pointer-events-none absolute inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex justify-center px-3 pt-0.5">
          <div
            className={`flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-md ring-2 sm:max-w-none ${
              micOn
                ? "bg-emerald-200 text-emerald-900 ring-emerald-100"
                : "bg-white/90 text-slate-600 ring-white"
            }`}
          >
            <span
              className={`inline-block size-2.5 rounded-full ${
                micOn ? "animate-pulse bg-emerald-500" : "bg-slate-300"
              }`}
            />
            {micOn
              ? phase === "calibrate"
                ? "Mic aan — probeer tok / taaaak!"
                : "Mic aan — zeg tok / taaaak!"
              : "Mic uit"}
          </div>
        </div>
      )}

      {phase === "intro" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto overscroll-y-contain bg-sky-500/35 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-[2px] sm:p-6">
          <div className="my-auto max-h-[min(92dvh,40rem)] w-full max-w-md overflow-y-auto overscroll-y-contain rounded-[2rem] border-4 border-white bg-white/95 px-4 py-6 text-center shadow-2xl ring-4 ring-amber-200/80 sm:p-8">
            <p className="text-sm font-bold uppercase tracking-widest text-sky-500">Stemrun</p>
            <h1 className="mt-2 text-3xl font-black text-amber-500 drop-shadow-sm md:text-4xl">
              Tok &amp; vrienden
            </h1>
            <p className="mt-2 text-sm font-bold text-slate-500">Kies je personage</p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  {
                    id: "chicken" as const,
                    label: "Kip",
                    blurb: "Klassieke kukeleku",
                    emoji: "🐤",
                    ring: "ring-amber-300",
                  },
                  {
                    id: "penguin" as const,
                    label: "Pinguïn",
                    blurb: "Waggelend & schattig",
                    emoji: "🐧",
                    ring: "ring-slate-400",
                  },
                  {
                    id: "flamingo" as const,
                    label: "Flamingo",
                    blurb: "Roze & lang",
                    emoji: "🦩",
                    ring: "ring-pink-300",
                  },
                  {
                    id: "wolf" as const,
                    label: "Wolf",
                    blurb: "Snel & stout",
                    emoji: "🐺",
                    ring: "ring-slate-500",
                  },
                ] as const
              ).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCharacter(c.id)}
                  className={`min-h-[3.25rem] touch-manipulation rounded-2xl border-4 bg-gradient-to-b px-3 py-4 text-center shadow-md transition active:brightness-95 ${
                    character === c.id
                      ? `${c.ring} border-amber-400 bg-white`
                      : "border-slate-200 bg-slate-50 hover:bg-white"
                  }`}
                >
                  <span className="text-4xl leading-none">{c.emoji}</span>
                  <p className="mt-2 text-base font-black text-slate-800">{c.label}</p>
                  <p className="text-xs font-semibold text-slate-500">{c.blurb}</p>
                </button>
              ))}
            </div>
            <p className="mt-4 text-base leading-relaxed text-slate-600">
              Zeg <span className="font-black text-amber-600">«tok»</span> om een stap op het pad te zetten, en{" "}
              <span className="font-black text-sky-600">«taaaak»</span> (langer!) om te springen — je gaat eerst{" "}
              <strong>omhoog</strong>, dan vooruit op het hoogtepunt van de sprong zodat je obstakels wipt in plaats van
              erin te schuiven.
            </p>
            <ul className="mt-4 space-y-2 text-left text-sm text-slate-600">
              <li className="flex gap-2">
                <span className="text-lg">🐤</span>
                <span>
                  <strong>Korte</strong> piep → één stap vooruit.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-lg">🪽</span>
                <span>
                  <strong>Lange</strong> piep → spring omhoog, dan vooruit op het hoogtepunt.
                </span>
              </li>
            </ul>
            <button
              type="button"
              onClick={goToCalibration}
              className="mt-6 w-full rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 py-4 text-lg font-black text-white shadow-[0_8px_0_#0f766e] transition hover:brightness-105 active:translate-y-1 active:shadow-none"
            >
              Microfoon instellen
            </button>
            <p className="mt-3 text-xs text-slate-400">
              Je test het niveau en start daarna de run. Tijdens de run alleen met je stem — tok en taaaak.
            </p>
          </div>
        </div>
      )}

      {phase === "calibrate" && (
        <div className="absolute inset-0 z-30 overflow-y-auto overscroll-y-contain bg-sky-600/40 px-4 pb-[calc(7.5rem+env(safe-area-inset-bottom,0px))] pt-[max(1rem,env(safe-area-inset-top,0px))] backdrop-blur-[2px] md:pb-[calc(8.5rem+env(safe-area-inset-bottom,0px))]">
          <div className="mx-auto my-4 max-w-lg rounded-[2rem] border-4 border-white bg-white/95 p-5 shadow-2xl ring-4 ring-amber-200/70 sm:p-6 md:p-8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-sky-500">Stap 1</p>
                <h2 className="text-2xl font-black text-amber-500">Microfooncheck</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  stopListening();
                  setCalibrateMoreOpen(false);
                  setPhase("intro");
                }}
                className="rounded-full border-2 border-slate-200 px-3 py-1 text-xs font-bold text-slate-600"
              >
                Terug
              </button>
            </div>

            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              Als de browser vraagt om toestemming, <span className="font-black text-emerald-700">sta de microfoon toe</span>.
              Daarna kun je met <span className="font-black text-slate-800">Start spel</span> beginnen; onder{" "}
              <span className="font-black text-slate-800">Meer opties</span> vind je extra instellingen.
            </p>

            {errorMessage && (
              <p className="mt-4 rounded-xl bg-rose-100 px-3 py-2 text-sm text-rose-800">{errorMessage}</p>
            )}

            <button
              type="button"
              onClick={() => void openMicForCalibration()}
              className="mt-5 w-full rounded-2xl bg-gradient-to-r from-emerald-400 to-teal-400 py-4 text-lg font-black text-white shadow-[0_8px_0_#0f766e] active:translate-y-1 active:shadow-none disabled:opacity-60"
              disabled={status === "requesting"}
            >
              {micOn ? "Microfoon staat aan" : "Microfoon aanzetten"}
            </button>

            {micOn && (
              <p className="mt-3 text-center text-sm font-semibold text-emerald-800">
                Microfoon staat klaar — tik op <span className="font-black">Start spel</span> wanneer je wilt.
              </p>
            )}

            <button
              type="button"
              onClick={beginGameFromCalibration}
              disabled={!micOn}
              className="mt-4 w-full rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 py-4 text-lg font-black text-white shadow-[0_8px_0_#c2410c] active:translate-y-1 active:shadow-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start spel
            </button>
            {!micOn && (
              <p className="mt-2 text-center text-xs font-semibold text-rose-600">
                Zet eerst de microfoon aan.
              </p>
            )}

            <button
              type="button"
              onClick={() => setCalibrateMoreOpen((o) => !o)}
              className="mt-4 w-full rounded-2xl border-2 border-slate-300 bg-slate-50 py-3 text-sm font-black text-slate-800 shadow-sm active:translate-y-px"
            >
              {calibrateMoreOpen ? "Minder opties" : "Meer opties"}
            </button>

            {calibrateMoreOpen && (
              <div className="mt-5 space-y-5 border-t border-slate-200 pt-5">
                <button
                  type="button"
                  onClick={() => void reconnectMic()}
                  className="w-full rounded-2xl border-2 border-emerald-300 bg-emerald-50 py-3 text-sm font-black text-emerald-900 disabled:opacity-50"
                  disabled={status === "requesting" || status === "idle"}
                >
                  Microfoon opnieuw verbinden
                </button>

                <p className="text-sm leading-relaxed text-slate-600">
                  Kijk naar de niveau-balk als je praat. Zet de gevoeligheid hoger als de balk bijna niet beweegt — of
                  trilt als je stil bent. Blijven de getallen op <span className="font-mono">0.00</span> staan, probeer
                  dan <span className="font-black">Microfoon opnieuw verbinden</span> nadat je toestemming hebt gegeven.
                </p>

                <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs leading-relaxed text-slate-600">
                  <span className="font-bold text-slate-700">Mic-debug:</span> filter in de console op{" "}
                  <code className="rounded bg-white px-1 font-mono text-[11px]">TokMic</code>, URL{" "}
                  <code className="rounded bg-white px-1 font-mono text-[11px]">?micDebug=1</code>, of{" "}
                  <code className="rounded bg-white px-1 font-mono text-[11px]">
                    localStorage.setItem(&quot;tok-mic-debug&quot;,&quot;1&quot;)
                  </code>
                  . Ingebouwde browsers kunnen stilte tonen — probeer Chrome of Safari.
                </p>

                <div className="mt-2">
              <div className="flex items-end justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Invoerniveau</p>
                <p className="text-xs font-semibold text-slate-500">
                  RMS {(meter.rms * 100).toFixed(2)} · peak {(meter.peak * 100).toFixed(2)} (×100)
                </p>
              </div>
              <div className="relative mt-2 h-5 w-full overflow-hidden rounded-full bg-slate-200 ring-2 ring-slate-300">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-sky-300 to-sky-500 transition-[width] duration-75"
                  style={{ width: `${meterPct}%` }}
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-amber-500/90"
                  style={{ left: `${openPct}%` }}
                  title="Vanaf hier telt het als praten begint"
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-emerald-700/80"
                  style={{ left: `${closePct}%` }}
                  title="Stilte vanaf hier"
                />
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-fuchsia-500/70"
                  style={{ left: `${peakPct}%` }}
                  title="Recente piek"
                />
              </div>
              <p className="mt-1 text-[11px] leading-snug text-slate-500">
                Oranje lijn ≈ drempel “start spreken”. Groene lijn ≈ “stop”. Magenta streepje = je recente piek.
                {meter.speaking ? (
                  <span className="font-bold text-emerald-700"> Je spreekt…</span>
                ) : (
                  <span> Stil.</span>
                )}
              </p>
                </div>

                <div className="mt-6 space-y-4">
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-bold text-slate-700" htmlFor="sens">
                    Gevoeligheid (hoger = ook zachtere geluiden)
                  </label>
                  <span className="text-sm font-black text-amber-600">{voice.sensitivity}</span>
                </div>
                <input
                  id="sens"
                  type="range"
                  min={1}
                  max={100}
                  value={voice.sensitivity}
                  onChange={(e) =>
                    setVoice((v) => ({ ...v, sensitivity: Number(e.target.value) || v.sensitivity }))
                  }
                  className="mt-2 w-full accent-amber-500"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-bold text-slate-700" htmlFor="boundary">
                    Grens kort/lang (ms)
                  </label>
                  <span className="text-sm font-black text-sky-700">{voice.boundaryMs} ms</span>
                </div>
                <input
                  id="boundary"
                  type="range"
                  min={220}
                  max={560}
                  step={10}
                  value={voice.boundaryMs}
                  onChange={(e) =>
                    setVoice((v) => ({ ...v, boundaryMs: Number(e.target.value) || v.boundaryMs }))
                  }
                  className="mt-2 w-full accent-sky-500"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Kortere tijden tellen als <span className="font-black text-amber-600">tok</span>. Langere als{" "}
                  <span className="font-black text-sky-700">taaaak</span>.
                </p>
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border-2 border-slate-200 bg-slate-50 p-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-emerald-600"
                  checked={voice.rawProcessing}
                  onChange={(e) => setVoice((v) => ({ ...v, rawProcessing: e.target.checked }))}
                />
                <span className="text-sm leading-snug text-slate-700">
                  <span className="font-black">Ruwere audio</span> zet ruisonderdrukking en automatische versterking uit.
                  Dat helpt vaak bij “er gebeurt niets” op sommige laptops — tik dan op{" "}
                  <span className="font-black">Microfoon opnieuw verbinden</span>.
                </span>
              </label>

              <div>
                <label className="text-sm font-bold text-slate-700" htmlFor="device">
                  Microfoon
                </label>
                <select
                  id="device"
                  className="mt-2 w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                  value={voice.deviceId}
                  onChange={(e) => setVoice((v) => ({ ...v, deviceId: e.target.value }))}
                >
                  <option value="">Standaardmicrofoon</option>
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microfoon (${d.deviceId.slice(0, 6)}…)`}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Na een andere microfoon te hebben gekozen, tik op{" "}
                  <span className="font-black">Microfoon opnieuw verbinden</span> (op telefoons vaak met jouw tik
                  verplicht).
                </p>
              </div>
                </div>

                <div className="mt-6 rounded-2xl border-2 border-amber-200 bg-amber-50/80 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-amber-900">Detectie testen</p>
                <button
                  type="button"
                  onClick={() => setTestLog([])}
                  className="text-xs font-bold text-amber-800 underline"
                >
                  Wissen
                </button>
              </div>
              <p className="mt-1 text-xs text-amber-900/80">
                Zeg een korte <span className="font-black">tok</span> en een langere{" "}
                <span className="font-black">taaaak</span>. Hieronder zouden regels moeten verschijnen.
              </p>
              <ul className="mt-3 max-h-40 space-y-2 overflow-auto text-sm">
                {testLog.length === 0 ? (
                  <li className="text-slate-500">Nog geen detecties.</li>
                ) : (
                  testLog.map((row, idx) => (
                    <li
                      key={`${row.at}-${idx}`}
                      className="flex items-center justify-between rounded-xl bg-white/90 px-3 py-2 font-semibold text-slate-800 ring-1 ring-amber-100"
                    >
                      <span className={row.kind === "tok" ? "text-amber-700" : "text-sky-700"}>
                        {row.kind === "tok" ? "tok (stap)" : "taaaak (sprong)"}
                      </span>
                      <span className="tabular-nums text-slate-500">{row.ms} ms</span>
                    </li>
                  ))
                )}
              </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === "gameover" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto overscroll-y-contain bg-rose-500/25 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-[2px] sm:p-6">
          <div className="my-auto max-h-[min(90dvh,32rem)] w-full max-w-md overflow-y-auto overscroll-y-contain rounded-[2rem] border-4 border-white bg-white/95 p-6 text-center shadow-2xl sm:p-8">
            <p className="text-4xl">🐣💨</p>
            <h2 className="mt-2 text-3xl font-black text-rose-500">Au!</h2>
            <p className="mt-2 text-lg text-slate-600">
              Punten: <span className="font-black text-amber-600">{score}</span>
            </p>
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => void playAgain()}
                className="w-full rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 px-6 py-6 text-lg font-black text-white shadow-[0_8px_0_#c2410c] active:translate-y-1 active:shadow-none"
              >
                Opnieuw spelen
              </button>
              {errorMessage && (
                <p className="rounded-xl bg-rose-100 px-3 py-2 text-left text-sm text-rose-800">{errorMessage}</p>
              )}
              <button
                type="button"
                onClick={() => {
                  stopListening();
                  setPhase("intro");
                }}
                className="w-full rounded-2xl border-2 border-slate-200 py-3 text-sm font-bold text-slate-600"
              >
                Startscherm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
