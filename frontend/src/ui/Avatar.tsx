import { useState } from "react";

type AvatarProps = {
  name: string;
  url?: string | null;
  className: string;
  imageAlt?: string;
};

export function Avatar({ name, url, className, imageAlt = "用户头像" }: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const showImage = Boolean(url && failedUrl !== url);
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-semibold text-accent-fg`}
    >
      {showImage ? (
        <img
          src={url ?? undefined}
          alt={imageAlt}
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(url ?? null)}
        />
      ) : (
        (name || "U").slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
