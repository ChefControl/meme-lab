// On-device smile/laugh sensor.
//
// Wraps MediaPipe FaceLandmarker (loaded from CDN at runtime) and turns face
// blendshapes into a single 0..1 smile signal. The privacy contract: raw camera
// frames are processed entirely in the browser and never recorded or uploaded —
// only the derived smile number is ever read by the rest of the app.

const VISION_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const WASM_PATH = `${VISION_CDN}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

interface Category { categoryName: string; score: number }
interface FaceLandmarkerResult { faceBlendshapes?: { categories: Category[] }[] }
interface FaceLandmarkerLike {
  detectForVideo(video: HTMLVideoElement, ts: number): FaceLandmarkerResult;
  close(): void;
}
interface VisionModule {
  FilesetResolver: { forVisionTasks(p: string): Promise<unknown> };
  FaceLandmarker: { createFromOptions(fileset: unknown, opts: unknown): Promise<FaceLandmarkerLike> };
}

export interface Calibration {
  neutral: number; // resting smile_raw (per-user, some people rest-smile)
  scale: number;   // smile_raw at a genuine laugh
}
export const DEFAULT_CAL: Calibration = { neutral: 0.08, scale: 0.7 };

export class LaughSensor {
  private landmarker: FaceLandmarkerLike | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  lastRaw = 0;
  faceVisible = false;
  ready = false;

  /** Step 1: request the camera. Called FIRST, right on the click gesture, so the
   *  browser permission prompt appears immediately (before the slow model load). */
  async startCamera(video: HTMLVideoElement): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "This browser won't expose the camera here. getUserMedia needs a secure context — " +
        "open the app at http://localhost:5050 (camera is blocked over a plain http:// LAN IP).",
      );
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 320, height: 240 }, audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
    this.video = video;
  }

  /** Step 2: load the MediaPipe model (the slow part — runs after camera is granted). */
  async loadModel(): Promise<void> {
    const vision = (await import(/* @vite-ignore */ VISION_CDN)) as VisionModule;
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
    const opts = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO" as const,
      outputFaceBlendshapes: true,
      numFaces: 1,
    });
    try {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
    this.ready = true;
  }

  /** Current raw smile (~0..1) from blendshapes, or null if no face. Call per frame. */
  sampleRaw(): number | null {
    if (!this.landmarker || !this.video || this.video.readyState < 2) return null;
    const res = this.landmarker.detectForVideo(this.video, performance.now());
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (!cats) { this.faceVisible = false; return null; }
    this.faceVisible = true;
    const get = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
    const smile = (get("mouthSmileLeft") + get("mouthSmileRight")) / 2;
    const open = get("jawOpen");
    const cheek = (get("cheekSquintLeft") + get("cheekSquintRight")) / 2;
    // Smile dominates; an open mouth + squinted cheeks signal a real belly-laugh,
    // but only count the open mouth when the mouth is already smiling (not talking/yawning).
    const raw = smile + 0.35 * open * (smile > 0.15 ? 1 : 0) + 0.15 * cheek;
    this.lastRaw = raw;
    return raw;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    try { this.landmarker?.close(); } catch { /* already closed */ }
    this.landmarker = null;
    this.stream = null;
    this.video = null;
    this.ready = false;
  }
}

/** Map a raw smile reading to 0..1 against the user's calibration. */
export function normalize(raw: number, cal: Calibration): number {
  const span = Math.max(0.05, cal.scale - cal.neutral);
  return Math.max(0, Math.min(1, (raw - cal.neutral) / span));
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Resting baseline = median of the neutral-pass samples. */
export function neutralFrom(samples: number[]): number {
  return samples.length ? percentile(samples, 50) : DEFAULT_CAL.neutral;
}

/** Laugh scale = high percentile of the funny-pass samples (the user's "big laugh"). */
export function scaleFrom(samples: number[], neutral: number): number {
  const hi = percentile(samples, 85);
  return Math.max(hi, neutral + 0.18); // guarantee usable dynamic range
}
