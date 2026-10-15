// Messages between the demo scene and the controls panel page. They travel
// through the panel agent (sendToHost / HtmlPanel.postMessage), so the page can
// be on another origin. The scene checks what the page sends before using it.

/** Sent by the page to change the object. */
export interface SceneControl {
  shape?: "knot" | "ico" | "box";
  color?: string;
  spin?: boolean;
  /** 1 is the object's own size. */
  scale?: number;
  caption?: string;
}

/** Sent by the scene when the object is clicked. */
export const SCENE_CLICK = "scene-click";

const SHAPES = new Set(["knot", "ico", "box"]);
const MAX_CAPTION_LENGTH = 200;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.5;

/** Returns the control if `data` is one, keeping only fields that are valid. */
export function parseSceneControl(data: unknown): SceneControl | null {
  if (typeof data !== "object" || data === null) return null;
  const { shape, color, spin, scale, caption } = data as Record<string, unknown>;
  const control: SceneControl = {};
  if (typeof shape === "string" && SHAPES.has(shape))
    control.shape = shape as SceneControl["shape"];
  if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) control.color = color;
  if (typeof spin === "boolean") control.spin = spin;
  if (typeof scale === "number" && scale >= MIN_SCALE && scale <= MAX_SCALE) control.scale = scale;
  if (typeof caption === "string") control.caption = caption.slice(0, MAX_CAPTION_LENGTH);
  return control;
}
