import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

const OUTPUT_SIZE = 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const VIEWPORT_SIZE = 320;

type AvatarCropperProps = {
  file: File;
  onCancel: () => void;
  onConfirm: (blob: Blob) => Promise<void>;
};

export function AvatarCropper({ file, onCancel, onConfirm }: AvatarCropperProps) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const baseScale = Math.max(VIEWPORT_SIZE / dimensions.width, VIEWPORT_SIZE / dimensions.height);
  const scale = baseScale * zoom;
  const displayedWidth = dimensions.width * scale;
  const displayedHeight = dimensions.height * scale;
  const maxX = Math.max(0, (displayedWidth - VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (displayedHeight - VIEWPORT_SIZE) / 2);
  const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));

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
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.9),
    );
    if (!blob || blob.type !== "image/webp") throw new Error("此浏览器无法生成 WebP 头像。");
    if (blob.size > MAX_OUTPUT_BYTES) throw new Error("裁剪后的头像超过 2 MiB，请缩小图片复杂度。");
    return blob;
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,20,19,0.56)] p-4">
      <section className="w-full max-w-[520px] rounded-xl border border-border-strong bg-bg-raised p-5 shadow-[0_24px_80px_rgba(20,20,19,0.28)]" role="dialog" aria-modal="true" aria-labelledby="avatar-crop-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="avatar-crop-title" className="text-[16px] font-semibold text-fg">裁剪头像</h2>
            <p className="mt-1 text-[11px] text-fg-subtle">拖动图片调整位置，使用滑块缩放。原图不会上传。</p>
          </div>
          <button type="button" aria-label="取消裁剪" className="flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover" onClick={onCancel}><X size={16} /></button>
        </div>

        <div className="mt-5 flex justify-center">
          <div
            className="relative h-[320px] w-[320px] max-w-full touch-none overflow-hidden rounded-lg bg-bg-sunken outline outline-1 outline-border-strong"
            aria-label="头像裁剪区域"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) return;
              setOffset({
                x: clamp(drag.offsetX + event.clientX - drag.x, maxX),
                y: clamp(drag.offsetY + event.clientY - drag.y, maxY),
              });
            }}
            onPointerUp={() => { dragRef.current = null; }}
            onPointerCancel={() => { dragRef.current = null; }}
          >
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
            <div className="pointer-events-none absolute inset-0 rounded-full ring-[80px] ring-black/45" aria-hidden="true" />
          </div>
        </div>

        <label className="mt-5 block text-[12px] font-medium text-fg" htmlFor="avatar-zoom">缩放</label>
        <input
          id="avatar-zoom"
          className="mt-2 w-full accent-[var(--color-accent)]"
          type="range"
          min="1"
          max="3"
          step="0.01"
          value={zoom}
          onChange={(event) => {
            const nextZoom = Number(event.target.value);
            setZoom(nextZoom);
            setOffset({ x: 0, y: 0 });
          }}
        />
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-border p-3">
          <div className="h-14 w-14 overflow-hidden rounded-full bg-bg-sunken">
            <img src={url} alt="圆形头像效果预览" className="h-full w-full object-cover" />
          </div>
          <p className="text-[11px] text-fg-subtle">实际头像会显示为圆形，成品为 512×512 静态 WebP。</p>
        </div>
        {error && <p className="mt-3 text-[12px] text-danger" role="alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="h-9 rounded-full border border-border-strong px-4 text-[12.5px] text-fg" onClick={onCancel}>取消</button>
          <button
            type="button"
            className="h-9 rounded-full bg-accent px-4 text-[12.5px] font-medium text-accent-fg disabled:opacity-60"
            disabled={submitting}
            onClick={() => {
              setSubmitting(true);
              setError(null);
              void createBlob()
                .then(onConfirm)
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "头像处理失败。"))
                .finally(() => setSubmitting(false));
            }}
          >
            {submitting ? "上传中…" : "确认并上传"}
          </button>
        </div>
      </section>
    </div>
  );
}
