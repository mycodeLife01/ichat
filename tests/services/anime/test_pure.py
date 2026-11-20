from datetime import datetime, timedelta, timezone

import pytest

from app.services.anime.filters import (
    InvalidFilters,
    compile_filters,
    title_skip_reason,
    validate_filters,
)
from app.services.anime.infohash import (
    InvalidInfohash,
    infohash_from_magnet,
    infohash_from_url,
    magnet_for,
    normalize_infohash,
)
from app.services.anime.parsing import parse_title
from app.services.anime.sources import parse_mikan_rss, redact_url

HASH = "409486487caa006f7afae7a3a432f7fb99b1f7a4"


def test_normalize_hex_and_base32() -> None:
    assert normalize_infohash(HASH.upper()) == HASH
    assert normalize_infohash("MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U") == (
        "6162636465666768696a6b6c6d6e6f7071727374"
    )
    with pytest.raises(InvalidInfohash):
        normalize_infohash("not-a-hash")


def test_infohash_from_magnet_and_mikan_urls() -> None:
    assert infohash_from_magnet(f"magnet:?xt=urn:btih:{HASH.upper()}&dn=x") == HASH
    assert infohash_from_url(f"https://mikanani.me/Download/20261120/{HASH}.torrent") == HASH
    assert infohash_from_url(f"https://mikanani.me/Home/Episode/{HASH}") == HASH
    assert magnet_for(HASH) == f"magnet:?xt=urn:btih:{HASH}"
    with pytest.raises(InvalidInfohash):
        infohash_from_url("https://mikanani.me/Home/Bangumi/3519")
    with pytest.raises(InvalidInfohash):
        infohash_from_magnet("https://example.com")


@pytest.mark.parametrize(
    ("title", "series", "episode", "group", "resolution", "lang", "batch"),
    [
        (
            "[LoliHouse] 冷淡的佐藤同学只对我撒娇 / Shiotaiou no Satou-san - 07 "
            "[WebRip 1080p HEVC-10bit AAC][简繁内封字幕]",
            "冷淡的佐藤同学只对我撒娇",
            7,
            "LoliHouse",
            "1080p",
            "chs+cht",
            False,
        ),
        (
            "[千夏字幕组][葬送的芙莉莲_Sousou no Frieren][第28话][1080p_HEVC][简繁内封][完]",
            "葬送的芙莉莲",
            28,
            "千夏字幕组",
            "1080p",
            "chs+cht",
            False,
        ),
        (
            "【悠哈璃羽字幕社】[葬送的芙莉莲_Sousou no Frieren][27v2][x264 1080p][CHT]",
            "葬送的芙莉莲",
            27,
            "悠哈璃羽字幕社",
            "1080p",
            "cht",
            False,
        ),
        (
            "[GJ.Y] 葬送的芙莉莲 / Sousou no Frieren - 28 (B-Global 3840x2160 HEVC AAC MKV)",
            "葬送的芙莉莲",
            28,
            "GJ.Y",
            "2160p",
            None,
            False,
        ),
        (
            "[Nix-Raws] 魔法骑士雷阿斯 / Magic Knight Rayearth S01E07 [CR WEB-DL 1080p][简繁内封]",
            "魔法骑士雷阿斯",
            7,
            "Nix-Raws",
            "1080p",
            "chs+cht",
            False,
        ),
        (
            "[LoliHouse] 鬼的新娘 / Oni no Hanayome [01-12 合集][WebRip 1080p HEVC-10bit AAC][Fin]",
            "鬼的新娘",
            None,
            "LoliHouse",
            "1080p",
            None,
            True,
        ),
        (
            "[桜都字幕组] 弹珠汽水瓶里的千岁同学 第二季 / Chitose-kun (2026) [06][1080P][简体内嵌]",
            "弹珠汽水瓶里的千岁同学 第二季",
            6,
            "桜都字幕组",
            "1080p",
            "chs",
            False,
        ),
    ],
)
def test_parse_title_common_formats(
    title: str,
    series: str,
    episode: int | None,
    group: str,
    resolution: str,
    lang: str | None,
    batch: bool,
) -> None:
    parsed = parse_title(title)
    assert parsed["series"] == series
    assert parsed["episode"] == episode
    assert parsed["group"] == group
    assert parsed["resolution"] == resolution
    assert parsed["subtitle_lang"] == lang
    assert parsed["is_batch"] is batch
    assert parsed["parser"] == "regex"


def test_parse_title_never_raises_on_garbage() -> None:
    parsed = parse_title("]]][[[ - - ")
    assert parsed["episode"] is None


def test_filters_validate_and_evaluate() -> None:
    doc = validate_filters({"include": ["1080p", "简繁"], "exclude": ["HEVC"]})
    assert doc["skip_batch"] is True and doc["backfill_hours"] == 24
    filters = compile_filters(doc)
    batch = {"is_batch": True}
    single = {"is_batch": False}
    assert title_skip_reason(filters, "[A] X - 01 [1080p][简繁]", single) is None
    assert title_skip_reason(filters, "[A] X - 01 [720p][简繁]", single) == "include"
    assert title_skip_reason(filters, "[A] X - 01 [1080p HEVC][简繁]", single) == "exclude"
    assert title_skip_reason(filters, "[A] X [1080p][简繁]", batch) == "batch"


@pytest.mark.parametrize(
    "raw",
    [
        {"unknown": 1},
        {"include": ["("]},
        {"include": "1080p"},
        {"include": ["x" * 201]},
        {"backfill_hours": -1},
        {"skip_batch": "yes"},
    ],
)
def test_filters_reject_invalid(raw: dict[str, object]) -> None:
    with pytest.raises(InvalidFilters):
        validate_filters(raw)


_RSS = f"""<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
<item><guid isPermaLink="false">t</guid>
<link>https://mikanani.me/Home/Episode/{HASH}</link>
<title>[喵萌奶茶屋&amp;amp;LoliHouse] 某番 - 01 [1080p]</title>
<torrent xmlns="https://mikanani.me/0.1/"><link>https://mikanani.me/Home/Episode/{HASH}</link>
<contentLength>281100481</contentLength><pubDate>2026-11-20T12:34:56.789</pubDate></torrent>
<enclosure type="application/x-bittorrent" length="281100481"
 url="https://mikanani.me/Download/20261120/{HASH}.torrent" /></item>
<item><title>no hash</title><link>https://mikanani.me/Home/Bangumi/1</link></item>
</channel></rss>""".encode()


def test_parse_mikan_rss_extracts_hash_size_and_beijing_time() -> None:
    items = parse_mikan_rss(_RSS)
    assert len(items) == 1
    item = items[0]
    assert item.infohash == HASH
    assert item.title == "[喵萌奶茶屋&LoliHouse] 某番 - 01 [1080p]"
    assert item.size_bytes == 281100481
    assert item.torrent_url and item.torrent_url.endswith(".torrent")
    assert item.published_at == datetime(
        2026, 11, 20, 12, 34, 56, 789000, tzinfo=timezone(timedelta(hours=8))
    )


def test_redact_url_hides_token() -> None:
    redacted = redact_url("https://mikanani.me/RSS/MyBangumi?token=secret%3d")
    assert "secret" not in redacted
    assert redacted == "https://mikanani.me/RSS/MyBangumi?token=%2A%2A%2A"
