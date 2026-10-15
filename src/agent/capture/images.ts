// An SVG loaded as an image does not load anything external, so every image the
// page shows has to be embedded as a data URL. Images are fetched in the
// background; until one arrives, the frame is drawn without it, and `onLoad`
// asks for another frame.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export class ImageInliner {
  /** Each URL fetched (once): its data URL, or null while it loads or if it failed. */
  readonly #dataUrls = new Map<string, string | null>();
  readonly #onLoad: () => void;

  constructor(onLoad: () => void) {
    this.#onLoad = onLoad;
  }

  /** The data URL for `url`, or null if it is not available (yet). */
  get(url: string): string | null {
    if (url.startsWith("data:")) return url;
    if (!this.#dataUrls.has(url)) {
      this.#dataUrls.set(url, null);
      fetchAsDataUrl(url)
        .then((dataUrl) => {
          this.#dataUrls.set(url, dataUrl);
          this.#onLoad();
        })
        // It stays null: not tried again.
        .catch(() => {});
    }
    return this.#dataUrls.get(url) ?? null;
  }
}

async function fetchAsDataUrl(url: string): Promise<string> {
  // Same-origin images are fetched like the page fetched them (with cookies);
  // cross-origin ones need CORS, as they would for a canvas.
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("image too large");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
