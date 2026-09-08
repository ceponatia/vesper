"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { charactersApi } from "@/lib/client/api";
import {
  AVATAR_HEIGHT,
  AVATAR_WIDTH,
  canvasRect,
  centeredOffset,
  clampOffset,
  displaySize,
  MAX_ZOOM,
  MIN_ZOOM,
  type Offset,
} from "@vesper/image-core";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";

export interface AvatarUploadDialogProps {
  open: boolean;
  onClose: () => void;
  characterId: string;
  name: string;
  /** Called with the new avatar image id once the upload + promotion succeed. */
  onUploaded: (avatarImageId: string) => void;
}

export interface PortraitCropUploadDialogProps {
  open: boolean;
  onClose: () => void;
  name: string;
  title: string;
  description: string;
  confirmLabel: string;
  onUpload: (dataUrl: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}

/** The crop window's on-screen size (3:4, matches AVATAR_WIDTH:AVATAR_HEIGHT). */
const FRAME = { fw: 288, fh: 384 };

interface LoadedImage {
  el: HTMLImageElement;
  url: string;
  nw: number;
  nh: number;
}

type Stage = "pick" | "crop" | "uploading";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Upload a profile image (docs/images/pipelines/avatar-upload.md §The crop
 * dialog): pick a file, then pan/zoom it inside a crop window before it is
 * scaled to the canonical
 * 768×1024 portrait and promoted to the character's avatar. The crop stage runs
 * for EVERY image — an already-3:4 file used to skip straight to upload (the
 * dialog silently vanishing read as a bug), and reframing is wanted even at the
 * right ratio (owner request 2026-07-29: zoom a knees-up render to waist-up).
 * At zoom 1 an already-3:4 image exactly fills the frame, so "Use image" with
 * no adjustment reproduces the old fast path. No model runs, so this works in
 * demo mode and offline.
 */
export function PortraitCropUploadDialog({ open, onClose, name, title, description, confirmLabel, onUpload }: PortraitCropUploadDialogProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  // Backdrop fill for the letterboxed area when zoomed out past cover (owner
  // request 2026-07-29) — previewed live as the frame's background and painted
  // under the image on save. Neutral studio grey, matching the generated-
  // portrait "plain background" convention.
  const [bgColor, setBgColor] = useState("#b8b4ae");
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; base: Offset } | null>(null);
  // Latest values for the imperative wheel/drag handlers (refs updated post-commit).
  const latest = useRef({ zoom, offset, image });
  useEffect(() => {
    latest.current = { zoom, offset, image };
  });

  const revoke = useCallback((img: LoadedImage | null) => {
    if (img) URL.revokeObjectURL(img.url);
  }, []);

  // Reset to a clean picker whenever the dialog opens, and release the object
  // URL when it closes — either way the next open starts fresh.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStage("pick");
      setError(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setBgColor("#b8b4ae");
    }
    setImage((prev) => {
      revoke(prev);
      return null;
    });
  }

  // Release the object URL if the component unmounts mid-flow.
  useEffect(() => () => revoke(latest.current.image), [revoke]);

  const renderToDataUrl = useCallback((img: LoadedImage, z: number, off: Offset, fill: string): string => {
    const disp = displaySize(FRAME, img, z);
    const rect = canvasRect(FRAME, disp.width, disp.height, off, AVATAR_WIDTH, AVATAR_HEIGHT);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_WIDTH;
    canvas.height = AVATAR_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    // The flat backdrop first (visible only where a zoomed-out image leaves the
    // canvas uncovered — JPEG has no alpha, so unpainted pixels would go black),
    // then the whole image at its display transform; the canvas clips overflow.
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, AVATAR_WIDTH, AVATAR_HEIGHT);
    ctx.drawImage(img.el, rect.dx, rect.dy, rect.dw, rect.dh);
    return canvas.toDataURL("image/jpeg", 0.92);
  }, []);

  const upload = useCallback(
    async (dataUrl: string) => {
      setStage("uploading");
      setError(null);
      const result = await onUpload(dataUrl);
      if (result.ok) {
        revoke(latest.current.image);
        onClose();
      } else {
        setError(result.message || "Upload failed.");
        setStage(latest.current.image ? "crop" : "pick");
      }
    },
    [onClose, onUpload, revoke],
  );

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setError(null);
      if (!file.type.startsWith("image/")) {
        setError("Please choose an image file.");
        return;
      }
      if (file.size > 30 * 1024 * 1024) {
        setError("That image is too large (max 30 MB).");
        return;
      }
      const url = URL.createObjectURL(file);
      const el = new Image();
      el.onload = () => {
        if (!el.naturalWidth || !el.naturalHeight) {
          setError("Could not read that image — try a different file.");
          URL.revokeObjectURL(url);
          return;
        }
        const img: LoadedImage = { el, url, nw: el.naturalWidth, nh: el.naturalHeight };
        const disp = displaySize(FRAME, img, 1);
        const off = centeredOffset(FRAME, disp.width, disp.height);
        revoke(latest.current.image);
        setImage(img);
        setZoom(1);
        setOffset(off);
        setStage("crop");
      };
      el.onerror = () => {
        setError("Could not load that image — try a different file.");
        URL.revokeObjectURL(url);
      };
      el.src = url;
    },
    [revoke],
  );

  // Zoom around the frame's center so the focal point stays put, then re-clamp.
  const zoomTo = useCallback((nextZoom: number) => {
    const { zoom: z0, offset: o0, image: img } = latest.current;
    if (!img) return;
    const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const oldDisp = displaySize(FRAME, img, z0);
    const newDisp = displaySize(FRAME, img, z);
    const fx = (FRAME.fw / 2 - o0.x) / oldDisp.width;
    const fy = (FRAME.fh / 2 - o0.y) / oldDisp.height;
    setZoom(z);
    setOffset(
      clampOffset(FRAME, newDisp.width, newDisp.height, {
        x: FRAME.fw / 2 - fx * newDisp.width,
        y: FRAME.fh / 2 - fy * newDisp.height,
      }),
    );
  }, []);

  // Non-passive wheel zoom (passive listeners can't preventDefault page scroll).
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || stage !== "crop") return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(latest.current.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [stage, zoomTo]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!image) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, base: latest.current.offset };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const img = latest.current.image;
    if (!drag || drag.pointerId !== e.pointerId || !img) return;
    const disp = displaySize(FRAME, img, latest.current.zoom);
    setOffset(
      clampOffset(FRAME, disp.width, disp.height, {
        x: drag.base.x + (e.clientX - drag.startX),
        y: drag.base.y + (e.clientY - drag.startY),
      }),
    );
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const disp = image ? displaySize(FRAME, image, zoom) : { width: 0, height: 0 };
  const requestClose = useCallback(() => {
    if (stage !== "uploading") onClose();
  }, [onClose, stage]);

  const footer =
    stage === "crop" ? (
      <>
        <Button variant="ghost" onClick={() => setStage("pick")}>
          Choose another
        </Button>
        <Button variant="primary" onClick={() => image && void upload(renderToDataUrl(image, zoom, offset, bgColor))}>
          {confirmLabel}
        </Button>
      </>
    ) : (
      <Button variant="ghost" onClick={requestClose} disabled={stage === "uploading"}>
        Cancel
      </Button>
    );

  return (
    <Dialog open={open} onClose={requestClose} title={title} footer={footer}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = ""; // allow re-picking the same file
        }}
      />

      {stage === "pick" ? (
        <div className="flex flex-col gap-4">
          <p>{description}</p>
          <p>
            The confirmed image is{" "}
            <span className="font-medium text-paper-200">
              {AVATAR_WIDTH} × {AVATAR_HEIGHT} px
            </span>{" "}
            — a 3:4 portrait. Reposition and zoom it in the crop window to frame the shot you want.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files?.[0]);
            }}
            className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-ink-500 bg-ink-900/40 px-4 py-10 text-center text-paper-400 transition-colors hover:border-accent-500 hover:text-paper-200"
          >
            <span className="text-2xl leading-none">↑</span>
            <span className="text-sm">Choose an image or drop one here</span>
          </button>
          {error ? <p className="text-xs text-danger-400">{error}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <div
            ref={frameRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            aria-label="Drag to reposition the crop"
            className="relative cursor-move touch-none overflow-hidden rounded-card border border-ink-600 select-none"
            style={{ width: FRAME.fw, height: FRAME.fh, backgroundColor: bgColor }}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL; next/image cannot size a draggable canvas-bound preview
              <img
                src={image.url}
                alt={name}
                draggable={false}
                className="pointer-events-none absolute max-w-none"
                style={{ left: offset.x, top: offset.y, width: disp.width, height: disp.height }}
              />
            ) : null}
            {stage === "uploading" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-ink-950/60 text-sm text-paper-300">
                Saving…
              </div>
            ) : null}
          </div>

          <label className="flex w-full items-center gap-3 text-xs text-paper-400">
            <span className="shrink-0">Zoom</span>
            <Slider
              value={zoom}
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.01}
              onChange={zoomTo}
              disabled={stage === "uploading"}
              className="flex-1"
            />
          </label>
          <label className="flex w-full items-center gap-3 text-xs text-paper-400">
            <span className="shrink-0">Backdrop</span>
            <input
              type="color"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              disabled={stage === "uploading"}
              aria-label="Backdrop color for the area the image doesn't cover"
              className="h-7 w-12 cursor-pointer rounded border border-ink-600 bg-transparent p-0.5"
            />
            <span className="text-paper-600">fills the space around the image when zoomed out</span>
          </label>
          <p className="text-xs text-paper-500">Drag to reposition · scroll or use the slider to zoom — out past the edges to fit more in.</p>
          {error ? <p className="text-xs text-danger-400">{error}</p> : null}
        </div>
      )}
    </Dialog>
  );
}

/** Character-avatar specialization of the shared 3:4 preview and crop flow. */
export function AvatarUploadDialog({ open, onClose, characterId, name, onUploaded }: AvatarUploadDialogProps) {
  return <PortraitCropUploadDialog
    open={open}
    onClose={onClose}
    name={name}
    title="Upload profile image"
    description="Upload any photo or artwork, then confirm how it will fit the character's portrait frame."
    confirmLabel="Use image"
    onUpload={async (dataUrl) => {
      const result = await charactersApi.uploadAvatar(characterId, dataUrl);
      if (!result.ok) return { ok: false, message: result.error.message };
      onUploaded(result.data.avatarImageId);
      return { ok: true };
    }}
  />;
}
