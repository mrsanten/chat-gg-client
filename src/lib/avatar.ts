/**
 * Resize + reencode wybranego pliku jako JPEG/PNG data URL gotowy do wysyłki
 * na server. Limit 128×128 px (avatar nie potrzebuje więcej, a wpłaca się
 * w 30 KB), JPEG q=0.85 dla zwykłych zdjęć, PNG dla obrazów z alpha.
 */
const TARGET_MAX = 128;
const QUALITY = 0.85;

export interface AvatarPrepResult {
  dataUrl: string;
  /** Rozmiar w bajtach po enkodingu base64 (przybliżony). */
  bytes: number;
}

export async function prepareAvatarFromFile(file: File): Promise<AvatarPrepResult> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Plik musi być obrazkiem (jpg/png/gif/webp).");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { canvas, hasAlpha } = drawScaled(img);
    // Animowane GIF-y zostają jako pierwsza klatka po przejściu przez canvas;
    // jeśli user wrzuci GIF i chce ruchu, póki co tracimy. MVP jest OK.
    const mime = hasAlpha || file.type === "image/png" ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mime, QUALITY);
    return { dataUrl, bytes: estimateBytes(dataUrl) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Nie udało się otworzyć obrazka."));
    img.src = src;
  });
}

function drawScaled(img: HTMLImageElement): { canvas: HTMLCanvasElement; hasAlpha: boolean } {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const max = Math.max(w, h);
  const scale = max > TARGET_MAX ? TARGET_MAX / max : 1;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Brak canvas 2d.");
  // Lekki crop do kwadratu — center-crop dla niesymetrycznych zdjęć,
  // żeby avatar był równo. Najpierw skalujemy żeby krótszy bok = TARGET_MAX,
  // potem cropujemy środek.
  const targetSide = Math.min(tw, th);
  canvas.width = targetSide;
  canvas.height = targetSide;
  const ctx2 = canvas.getContext("2d")!;
  const sx = (tw - targetSide) / 2 / scale;
  const sy = (th - targetSide) / 2 / scale;
  const sw = targetSide / scale;
  const sh = targetSide / scale;
  ctx2.drawImage(img, sx, sy, sw, sh, 0, 0, targetSide, targetSide);
  return { canvas, hasAlpha: detectAlpha(ctx2, targetSide) };
}

function detectAlpha(ctx: CanvasRenderingContext2D, side: number): boolean {
  // Sample-ujemy kilka pikseli zamiast skanować całość — wystarczy do
  // zorientowania się, czy obrazek ma przezroczystość.
  try {
    const data = ctx.getImageData(0, 0, side, side).data;
    for (let i = 3; i < data.length; i += 4 * 64) {
      if (data[i] < 250) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function estimateBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  return Math.floor((b64.length * 3) / 4);
}

// ─────────────────────────────────── Obrazy w wiadomościach

/**
 * Skaluje obraz z czatu przed wysłaniem do innego usera: maks 1280 px
 * dłuższy bok, JPEG q=0.8 (PNG zachowane dla przezroczystości). Trzyma
 * payload WS w ryzach. Zwraca oryginał gdy coś pójdzie nie tak.
 */
const MSG_IMG_MAX = 1280;
const MSG_IMG_QUALITY = 0.8;

export async function compressMessageImage(img: {
  mimeType: string;
  base64: string;
}): Promise<{ mimeType: string; base64: string }> {
  const srcUrl = `data:${img.mimeType};base64,${img.base64}`;
  try {
    const el = await loadImage(srcUrl);
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    const max = Math.max(w, h);
    const scale = max > MSG_IMG_MAX ? MSG_IMG_MAX / max : 1;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return img;
    ctx.drawImage(el, 0, 0, tw, th);
    const mime = img.mimeType === "image/png" ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mime, MSG_IMG_QUALITY);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return img;
    return { mimeType: mime, base64: dataUrl.slice(comma + 1) };
  } catch {
    return img;
  }
}
