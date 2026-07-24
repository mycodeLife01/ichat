import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { buttonControl, iconControl, primaryButton } from "../ui/classes";
import { InlineStatus } from "../ui/InlineStatus";
import { LoadingButtonContent } from "../ui/LoadingButtonContent";
import { ModalDialog } from "../ui/ModalDialog";

const OUTPUT_SIZE = 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const VIEWPORT_SIZE = 320;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

type CropGesture =
  | { kind: "drag"; x: number; y: number; offsetX: number; offsetY: number }
  | { kind: "pinch"; distance: number; zoom: number };

type AvatarCropperProps = {
  file: File;
  onCancel: () => void;
  onConfirm: (blob: Blob) => Promise<void>;
  onError: (message: string) => void;
};

export function AvatarCropper({ file, onCancel, onConfirm, onError }: AvatarCropperProps) {
  const [url, setUrl] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<CropGesture | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create and revoke the object URL in the same effect so StrictMode's
  // mount -> cleanup -> mount cycle never leaves a revoked URL in use.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const baseScale = Math.max(VIEWPORT_SIZE / dimensions.width, VIEWPORT_SIZE / dimensions.height);
  const scale = baseScale * zoom;
  const displayedWidth = dimensions.width * scale;
  const displayedHeight = dimensions.height * scale;
  const maxX = Math.max(0, (displayedWidth - VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (displayedHeight - VIEWPORT_SIZE) / 2);
  const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));

  const boundsFor = (nextZoom: number) => {
    const nextScale = baseScale * nextZoom;
    return {
      x: Math.max(0, (dimensions.width * nextScale - VIEWPORT_SIZE) / 2),
      y: Math.max(0, (dimensions.height * nextScale - VIEWPORT_SIZE) / 2),
    };
  };

  const pinchDistance = () => {
    const [first, second] = [...pointersRef.current.values()];
    return Math.hypot(first.x - second.x, first.y - second.y) || 1;
  };

  const restartGesture = () => {
    const points = [...pointersRef.current.values()];
    if (points.length >= 2) {
      gestureRef.current = { kind: "pinch", distance: pinchDistance(), zoom };
    } else if (points.length === 1) {
      gestureRef.current = {
        kind: "drag",
        x: points[0].x,
        y: points[0].y,
        offsetX: offset.x,
        offsetY: offset.y,
      };
    } else {
      gestureRef.current = null;
    }
  };

  const createBlob = async () => {
    const image = imageRef.current;
    if (!image) throw new Error("Image is not ready");
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    const outputScale = (scale * OUTPUT_SIZE) / VIEWPORT_SIZE;
    const drawWidth = dimensions.width * outputScale;
    const drawHeight = dimensions.height * outputScale;
    context.drawImage(
      image,
      (OUTPUT_SIZE - drawWidth) / 2 + (offset.x * OUTPUT_SIZE) / VIEWPORT_SIZE,
      (OUTPUT_SIZE - drawHeight) / 2 + (offset.y * OUTPUT_SIZE) / VIEWPORT_SIZE,
      drawWidth,
      drawHeight,
    );
    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    // Safari cannot encode WebP from canvas: fall back to PNG, then to a
    // white-flattened JPEG when the PNG exceeds the upload size limit.
    let blob = await encode("image/webp", 0.9);
    if (!blob || blob.type !== "image/webp") {
      blob = await encode("image/png");
      if (blob && blob.type === "image/png" && blob.size > MAX_OUTPUT_BYTES) {
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
        blob = await encode("image/jpeg", 0.9);
      }
    }
    if (!blob || !["image/webp", "image/png", "image/jpeg"].includes(blob.type)) {
      throw new Error("此浏览器无法导出头像图片。");
    }
    if (blob.size > MAX_OUTPUT_BYTES) throw new Error("裁剪后的头像超过 2 MiB，请缩小图片复杂度。");
    return blob;
  };

  return (
    <ModalDialog
      titleId="avatar-crop-title"
      onClose={onCancel}
      className="w-full max-w-[520px] p-5"
      backdropClassName="z-[60] p-4"
    >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="avatar-crop-title" className="text-[16px] font-semibold text-fg">裁剪头像</h2>
            <p className="mt-1 text-[11px] text-fg-subtle">
              拖动图片调整位置，<span className="pointer-coarse:hidden">使用滑块缩放</span>
              <span className="hidden pointer-coarse:inline">双指开合缩放</span>
            </p>
          </div>
          <button
            type="button"
            aria-label="取消裁剪"
            className={`${iconControl} h-8 w-8`}
            data-dialog-initial-focus
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 flex justify-center">
          <div
            className="relative h-[320px] w-[320px] max-w-full touch-none overflow-hidden rounded-card bg-sunken outline outline-1 outline-border-strong"
            aria-label="头像裁剪区域"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              restartGesture();
            }}
            onPointerMove={(event) => {
              if (!pointersRef.current.has(event.pointerId)) return;
              pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const gesture = gestureRef.current;
              if (!gesture) return;
              if (gesture.kind === "pinch" && pointersRef.current.size >= 2) {
                const nextZoom = Math.min(
                  MAX_ZOOM,
                  Math.max(MIN_ZOOM, (gesture.zoom * pinchDistance()) / gesture.distance),
                );
                const max = boundsFor(nextZoom);
                setZoom(nextZoom);
                setOffset((previous) => ({
                  x: clamp(previous.x, max.x),
                  y: clamp(previous.y, max.y),
                }));
              } else if (gesture.kind === "drag") {
                setOffset({
                  x: clamp(gesture.offsetX + event.clientX - gesture.x, maxX),
                  y: clamp(gesture.offsetY + event.clientY - gesture.y, maxY),
                });
              }
            }}
            onPointerUp={(event) => {
              pointersRef.current.delete(event.pointerId);
              restartGesture();
            }}
            onPointerCancel={(event) => {
              pointersRef.current.delete(event.pointerId);
              restartGesture();
            }}
          >
            {url && (
              <img
                ref={imageRef}
                src={url}
                alt="待裁剪头像"
                draggable={false}
                className="pointer-events-none absolute top-1/2 left-1/2 max-w-none select-none"
                style={{
                  width: displayedWidth,
                  height: displayedHeight,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }}
                onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              />
            )}
            <div className="pointer-events-none absolute inset-0 rounded-pill ring-[80px] ring-overlay" aria-hidden="true" />
          </div>
        </div>

        <label className="mt-5 block text-[12px] font-medium text-fg pointer-coarse:hidden" htmlFor="avatar-zoom">缩放</label>
        <input
          id="avatar-zoom"
          className="mt-2 w-full accent-[var(--color-accent)] pointer-coarse:hidden"
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step="0.01"
          value={zoom}
          aria-invalid={error != null}
          aria-describedby={error ? "avatar-crop-error" : undefined}
          onChange={(event) => {
            const nextZoom = Number(event.target.value);
            setZoom(nextZoom);
            setOffset({ x: 0, y: 0 });
          }}
        />
        {error && (
          <InlineStatus tone="error" className="mt-3">
            <span id="avatar-crop-error">{error}</span>
          </InlineStatus>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${buttonControl} h-9 px-4 text-[12.5px]`} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={`${primaryButton} h-9 px-4 text-[12.5px] font-medium`}
            disabled={submitting}
            aria-busy={submitting}
            aria-label={submitting ? "正在确认并上传" : "确认并上传"}
            onClick={() => {
              setSubmitting(true);
              setError(null);
              void createBlob()
                .then(onConfirm)
                .catch((reason: unknown) => {
                  const message = reason instanceof Error ? reason.message : "头像处理失败。";
                  setError(message);
                  onError(message);
                })
                .finally(() => setSubmitting(false));
            }}
          >
            <LoadingButtonContent loading={submitting} label="确认并上传" />
          </button>
        </div>
    </ModalDialog>
  );
}
