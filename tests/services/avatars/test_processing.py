from io import BytesIO

import pytest
from PIL import Image

from app.services.avatars.processing import PermanentAvatarError, render_avatar


def webp(size: tuple[int, int] = (1024, 1024), *, alpha: int = 255) -> bytes:
    image = Image.new("RGBA", size, (20, 40, 60, alpha))
    output = BytesIO()
    image.save(output, format="WEBP", quality=90, lossless=True)
    return output.getvalue()


def encoded(format_name: str, mode: str = "RGB", size: tuple[int, int] = (1024, 1024)) -> bytes:
    image = Image.new(mode, size, (20, 40, 60))
    output = BytesIO()
    image.save(output, format=format_name)
    return output.getvalue()


def test_render_avatar_produces_static_512_webp_and_keeps_alpha() -> None:
    rendered = render_avatar(webp(alpha=0), max_bytes=2 * 1024 * 1024)
    with Image.open(BytesIO(rendered)) as image:
        assert image.format == "WEBP"
        assert image.size == (512, 512)
        assert getattr(image, "n_frames", 1) == 1
        assert image.convert("RGBA").getpixel((0, 0))[3] == 0
        assert not image.info.get("exif")


@pytest.mark.parametrize("source_format", ["PNG", "JPEG"])
def test_render_avatar_accepts_png_and_jpeg_sources(source_format: str) -> None:
    rendered = render_avatar(encoded(source_format), max_bytes=2 * 1024 * 1024)
    with Image.open(BytesIO(rendered)) as image:
        assert image.format == "WEBP"
        assert image.size == (512, 512)


def test_render_avatar_rejects_unsupported_formats_and_wrong_dimensions() -> None:
    with pytest.raises(PermanentAvatarError, match="invalid_image"):
        render_avatar(b"not-an-image", max_bytes=2 * 1024 * 1024)

    with pytest.raises(PermanentAvatarError, match="invalid_image"):
        render_avatar(encoded("GIF", mode="P"), max_bytes=2 * 1024 * 1024)

    with pytest.raises(PermanentAvatarError, match="invalid_dimensions"):
        render_avatar(webp((512, 512)), max_bytes=2 * 1024 * 1024)


def test_render_avatar_rejects_oversize_before_decode() -> None:
    with pytest.raises(PermanentAvatarError, match="invalid_image"):
        render_avatar(b"x" * 11, max_bytes=10)
