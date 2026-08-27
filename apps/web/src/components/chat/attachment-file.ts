/**
 * Composer-side photo prep: downscale a picked file on a canvas so the upload's
 * base64 stays well inside the route's string cap
 * (phone photos are 3–12 MB; the server re-fits to 1280px anyway, so nothing
 * is lost). Returns a `data:image/jpeg` URL, or null for anything unreadable —
 * the caller toasts and skips, never blocks the send.
 */

/** Longest side after the client-side downscale (the server refits to 1280). */
const CLIENT_MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

export async function fileToAttachmentDataUrl(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) return null;
    const scale = Math.min(1, CLIENT_MAX_DIM / longest);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}
