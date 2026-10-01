from __future__ import annotations

import multiprocessing
from io import BytesIO
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.services.files import parser_worker, parsers
from app.services.files.formats import FileFormat, FileLimits, policy_for_filename
from app.services.files.parsers import parse_file, parse_in_subprocess
from app.services.files.protocols import FileProcessingError, ProcessedFile


def _document_text(result: ProcessedFile) -> str:
    # Keep test helpers independent of storage/ORM integration details.
    extract = result.document_extract
    assert extract is not None
    return extract.content.decode("utf-8")


def _parse_from_daemonic_process(queue: Any) -> None:
    try:
        result = parse_in_subprocess(
            b"daemon-safe",
            FileFormat.TXT,
            timeout_seconds=5,
            memory_limit_bytes=None,
        )
        queue.put(("ok", _document_text(result)))
    except BaseException as error:
        queue.put(("error", type(error).__name__))


def _zip_bytes(parts: dict[str, str | bytes]) -> bytes:
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)
    return output.getvalue()


def _replace_zip_parts(source: bytes, replacements: dict[str, str | bytes]) -> bytes:
    parts: dict[str, str | bytes] = {}
    with ZipFile(BytesIO(source)) as archive:
        for info in archive.infolist():
            parts[info.filename] = archive.read(info.filename)
    parts.update(replacements)
    return _zip_bytes(parts)


def _content_types(main_part: str, media_type: str) -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/{main_part}" ContentType="{media_type}" />
</Types>'''


def _text_pdf(*, encrypted: bool = False) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
    )
    contents = DecodedStreamObject()
    contents.set_data(b"BT /F1 12 Tf 72 72 Td (Readable PDF text) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(contents)
    if encrypted:
        writer.encrypt("not-stored")
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _docx() -> bytes:
    document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p><w:r><w:t>Visible paragraph</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Hidden run</w:t></w:r></w:p>
  <w:p><w:del><w:r><w:delText>Deleted run</w:delText></w:r></w:del></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
 </w:body>
</w:document>'''
    return _zip_bytes(
        {
            "[Content_Types].xml": _content_types(
                "word/document.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            ),
            "word/document.xml": document,
        }
    )


def _pptx() -> bytes:
    presentation = '''<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2" show="0"/></p:sldIdLst>
</p:presentation>'''
    relationships = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Target="slides/slide1.xml" Type="slide"/>
 <Relationship Id="rId2" Target="slides/slide2.xml" Type="slide"/>
</Relationships>'''
    slide = '''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Visible slide</a:t></a:r></a:p>
 </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>'''
    hidden_slide = slide.replace("Visible slide", "Hidden slide")
    return _zip_bytes(
        {
            "[Content_Types].xml": _content_types(
                "ppt/presentation.xml",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
            ),
            "ppt/presentation.xml": presentation,
            "ppt/_rels/presentation.xml.rels": relationships,
            "ppt/slides/slide1.xml": slide,
            "ppt/slides/slide2.xml": hidden_slide,
        }
    )


def _xlsx() -> bytes:
    workbook = '''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets><sheet name="Visible" sheetId="1" r:id="rId1"/>
 <sheet name="Hidden" sheetId="2" r:id="rId2" state="hidden"/></sheets>
</workbook>'''
    relationships = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/>
 <Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="worksheet"/>
</Relationships>'''
    sheet = '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <cols><col min="2" max="2" hidden="1"/></cols><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>
   <c r="C1"><f>SUM(1,2)</f><v>3</v></c></row>
  <row r="2" hidden="1"><c r="A2" t="s"><v>1</v></c></row>
 </sheetData></worksheet>'''
    return _zip_bytes(
        {
            "[Content_Types].xml": _content_types(
                "xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            ),
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": relationships,
            "xl/worksheets/sheet1.xml": sheet,
            "xl/worksheets/sheet2.xml": sheet.replace("Visible", "Hidden"),
            "xl/sharedStrings.xml": '''<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Hello</t></si><si><t>Secret</t></si></sst>''',
        }
    )


def _xlsx_date(*, date_1904: bool, serial: int) -> bytes:
    workbook = f'''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <workbookPr date1904="{1 if date_1904 else 0}"/>
 <sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets>
</workbook>'''
    relationships = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/>
</Relationships>'''
    sheet = f'''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetData><row r="1"><c r="A1" s="0"><v>{serial}</v></c></row></sheetData>
</worksheet>'''
    styles = '''<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <cellXfs count="1"><xf numFmtId="14"/></cellXfs>
</styleSheet>'''
    return _zip_bytes(
        {
            "[Content_Types].xml": _content_types(
                "xl/workbook.xml",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
            ),
            "xl/workbook.xml": workbook,
            "xl/_rels/workbook.xml.rels": relationships,
            "xl/worksheets/sheet1.xml": sheet,
            "xl/styles.xml": styles,
        }
    )


def test_text_parser_normalizes_bom_and_newlines_without_mutating_original() -> None:
    source = b"\xef\xbb\xbfhello\r\nworld\r"
    result = parse_file(source, policy_for_filename("note.txt"))
    assert _document_text(result) == "hello\nworld\n"
    assert result.original.content == source


def test_text_parser_accepts_utf16_bom_and_warns_about_normalization() -> None:
    source = "你好\r\nworld".encode("utf-16")

    result = parse_file(source, policy_for_filename("note.txt"))

    assert _document_text(result) == "你好\nworld"
    assert result.original.content == source
    assert result.warnings == ("text_encoding_normalized",)


@pytest.mark.parametrize(
    ("source", "code"),
    [(b"nul\0", "nul_byte_not_allowed"), (b"\xff", "invalid_text_encoding")],
)
def test_text_parser_rejects_binary_and_non_utf8(source: bytes, code: str) -> None:
    with pytest.raises(FileProcessingError, match=code):
        parse_file(source, policy_for_filename("note.md"))


@pytest.mark.parametrize(
    ("text", "encoding", "filename"),
    [
        ("名称,数量\r\n苹果,3", "gb18030", "table.csv"),
        ("你好，世界", "gb18030", "note.txt"),
        ("中文", "gb18030", "short.txt"),
        ("北京市朝阳区建国路88号", "gb18030", "address.txt"),
        ("繁體字也可以用國標編碼保存。", "gb18030", "traditional-gb.txt"),
        ("名稱,數量\r\n蘋果,3\r\n香蕉,5", "big5", "table.csv"),
        ("你好，世界", "big5", "note.txt"),
        ("會議紀要\n1. 討論了第三季度的銷售目標", "big5", "minutes.md"),
        ("臺北市信義區市府路1號", "big5", "address.txt"),
    ],
)
def test_text_parser_falls_back_to_legacy_chinese_encodings(
    text: str, encoding: str, filename: str
) -> None:
    source = text.encode(encoding)
    with pytest.raises(UnicodeDecodeError):
        source.decode("utf-8")

    result = parse_file(source, policy_for_filename(filename))

    assert "text_encoding_normalized" in result.warnings
    assert _document_text(result) == text.replace("\r\n", "\n")


@pytest.mark.parametrize(
    ("filename", "source"),
    [
        ("Dockerfile", b"FROM python:3.12-slim\nRUN echo ok\n"),
        (".env", b"KEY=value\n"),
        ("main.rs", b"fn main() {}\n"),
    ],
)
def test_unlisted_and_code_files_parse_as_text(filename: str, source: bytes) -> None:
    result = parse_file(source, policy_for_filename(filename))

    assert result.media_type == "text/plain"
    assert _document_text(result) == source.decode()


def test_renamed_executable_is_rejected_as_text() -> None:
    executable = b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00" * 8
    with pytest.raises(FileProcessingError):
        parse_file(executable, policy_for_filename("setup.txt"))


def test_csv_shape_limit_warns_without_rejecting_content() -> None:
    result = parse_file(b"not: [valid", policy_for_filename("broken.yaml"))
    assert _document_text(result) == "not: [valid"
    too_many_columns = b",".join([b"x"] * 257)
    csv_result = parse_file(too_many_columns, policy_for_filename("table.csv"))
    assert _document_text(csv_result) == too_many_columns.decode()
    assert csv_result.warnings == ("csv_shape_limit_exceeded",)
    assert csv_result.metadata["max_columns"] == 257


def test_image_parser_verifies_real_type_uses_first_frame_and_strips_metadata() -> None:
    source_image = Image.new("RGB", (5, 4), (20, 40, 60))
    source = BytesIO()
    source_image.save(source, format="PNG", exif=b"Exif\x00\x00metadata")
    result = parse_file(source.getvalue(), policy_for_filename("photo.png"))
    assert result.kind == "display_only"
    with Image.open(BytesIO(result.preview.content)) as preview:
        assert preview.format == "WEBP"
        assert preview.size == (5, 4)
        assert not preview.info.get("exif")

    second_frame = Image.new("RGB", (5, 4), (80, 100, 120))
    animated = BytesIO()
    source_image.save(
        animated,
        format="WEBP",
        save_all=True,
        append_images=[second_frame],
        duration=100,
        loop=0,
    )
    animated_result = parse_file(animated.getvalue(), policy_for_filename("animated.webp"))
    assert animated_result.kind == "display_only"
    assert animated_result.warnings == ("animated_image_first_frame_only",)
    assert animated_result.metadata["frame_count"] == 2
    with Image.open(BytesIO(animated_result.preview.content)) as preview:
        assert getattr(preview, "n_frames", 1) == 1

    renamed = parse_file(source.getvalue(), policy_for_filename("photo.jpg"))
    assert renamed.format == "png"
    assert renamed.media_type == "image/png"
    assert renamed.original.content_type == "image/png"
    assert renamed.warnings == ("format_corrected",)


@pytest.mark.parametrize("filename", ["notes.txt", "photo.jpg", "slides.docx"])
def test_cross_category_content_is_rejected(filename: str) -> None:
    with pytest.raises(FileProcessingError, match="file_format_mismatch"):
        parse_file(_text_pdf(), policy_for_filename(filename))


def test_image_admission_uses_injected_limits() -> None:
    limits = FileLimits(image_max_edge=100, image_max_pixels=5_000)
    with pytest.raises(FileProcessingError, match="image_dimensions_exceeded"):
        parse_file(_png_bytes((101, 10)), policy_for_filename("wide.png"), limits=limits)
    with pytest.raises(FileProcessingError, match="image_pixel_limit_exceeded"):
        parse_file(_png_bytes((100, 51)), policy_for_filename("big.png"), limits=limits)
    with pytest.raises(FileProcessingError, match="file_too_large"):
        parse_file(
            _png_bytes((10, 10)),
            policy_for_filename("small.png"),
            limits=FileLimits(image_max_bytes=10),
        )


def test_long_screenshot_is_admitted_with_readable_preview() -> None:
    result = parse_file(_png_bytes((1080, 10_000)), policy_for_filename("long.png"))

    assert (result.metadata["width"], result.metadata["height"]) == (657, 6085)
    assert (result.metadata["original_width"], result.metadata["original_height"]) == (
        1080,
        10_000,
    )


def test_gif_uses_first_frame_with_warning() -> None:
    first = Image.new("RGB", (6, 4), (255, 0, 0))
    second = Image.new("RGB", (6, 4), (0, 0, 255))
    source = BytesIO()
    first.save(source, format="GIF", save_all=True, append_images=[second], duration=100)

    result = parse_file(source.getvalue(), policy_for_filename("loop.gif"))

    assert result.media_type == "image/gif"
    assert result.warnings == ("animated_image_first_frame_only",)
    assert result.metadata["frame_count"] == 2
    with Image.open(BytesIO(result.preview.content)) as preview:
        assert preview.format == "WEBP"
        assert preview.size == (6, 4)


def test_heic_is_decoded_upright_into_webp_preview() -> None:
    from pillow_heif import register_heif_opener

    register_heif_opener()
    image = Image.new("RGB", (64, 32), (200, 30, 30))
    exif = Image.Exif()
    exif[0x0112] = 6
    source = BytesIO()
    image.save(source, format="HEIF", quality=90, exif=exif.tobytes())

    result = parse_file(source.getvalue(), policy_for_filename("IMG_0001.HEIC"))

    assert result.format == "heic"
    assert result.original.content_type == "image/heic"
    assert result.preview.content_type == "image/webp"
    assert (result.metadata["width"], result.metadata["height"]) == (32, 64)
    assert (result.metadata["original_width"], result.metadata["original_height"]) == (32, 64)
    # A HEIC renamed to .jpg is corrected within the image category.
    renamed = parse_file(source.getvalue(), policy_for_filename("photo.jpg"))
    assert renamed.format == "heic"
    assert renamed.warnings == ("format_corrected",)


def _png_bytes(size: tuple[int, int]) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, (30, 60, 90)).save(output, format="PNG")
    return output.getvalue()


def _jpeg_bytes(size: tuple[int, int], *, orientation: int | None = None) -> bytes:
    image = Image.new("RGB", size, (200, 30, 30))
    # Mark the top-left corner so the orientation of the preview is observable.
    image.paste((20, 200, 20), (0, 0, size[0] // 4, size[1] // 4))
    exif = Image.Exif()
    if orientation is not None:
        exif[0x0112] = orientation
    output = BytesIO()
    image.save(output, format="JPEG", quality=95, exif=exif)
    return output.getvalue()


def test_image_parser_applies_exif_orientation_to_preview() -> None:
    # Orientation 6 means the stored pixels must be rotated 90 degrees clockwise.
    result = parse_file(_jpeg_bytes((80, 40), orientation=6), policy_for_filename("photo.jpg"))

    assert result.extractor_version == "image-v2"
    assert result.metadata["width"] == 40
    assert result.metadata["height"] == 80
    assert result.metadata["original_width"] == 40
    assert result.metadata["original_height"] == 80
    with Image.open(BytesIO(result.preview.content)) as preview:
        assert preview.size == (40, 80)
        assert not preview.getexif()
        rgb = preview.convert("RGB")
        # The marked source corner moves to the top-right after rotation.
        top_right = rgb.getpixel((35, 4))
        top_left = rgb.getpixel((4, 4))
    assert isinstance(top_right, tuple) and top_right[1] > 150
    assert isinstance(top_left, tuple) and top_left[0] > 150


def test_image_parser_downscales_preview_to_pixel_budget_without_upscaling() -> None:
    large = parse_file(_jpeg_bytes((4000, 3000)), policy_for_filename("large.jpg"))
    assert large.metadata["width"] * large.metadata["height"] <= parsers.MAX_PREVIEW_PIXELS
    assert large.metadata["original_width"] == 4000
    assert large.metadata["original_height"] == 3000
    assert abs(large.metadata["width"] / large.metadata["height"] - 4 / 3) < 0.01
    with Image.open(BytesIO(large.preview.content)) as preview:
        assert preview.size == (large.metadata["width"], large.metadata["height"])

    small = parse_file(_jpeg_bytes((640, 480)), policy_for_filename("small.jpg"))
    assert (small.metadata["width"], small.metadata["height"]) == (640, 480)


def test_preview_size_keeps_long_screenshots_readable() -> None:
    assert parsers._preview_size(1080, 10_000) == (657, 6085)
    assert parsers._preview_size(8064, 6048) == (2309, 1732)
    assert parsers._preview_size(1920, 1080) == (1920, 1080)


def test_image_parser_accepts_multi_picture_jpeg_as_single_frame() -> None:
    primary = Image.new("RGB", (40, 30), (10, 20, 30))
    secondary = Image.new("RGB", (20, 15), (200, 200, 200))
    source = BytesIO()
    primary.save(source, format="MPO", save_all=True, append_images=[secondary])

    result = parse_file(source.getvalue(), policy_for_filename("hdr.jpg"))

    assert result.warnings == ()
    assert result.metadata["frame_count"] == 1
    assert (result.metadata["width"], result.metadata["height"]) == (40, 30)


def test_pdf_parser_uses_real_pdf_pages_and_rejects_encryption() -> None:
    result = parse_file(_text_pdf(), policy_for_filename("paper.pdf"))
    assert "--- Page 1 ---" in _document_text(result)
    assert "Readable PDF text" in _document_text(result)
    with pytest.raises(FileProcessingError, match="encrypted_document"):
        parse_file(_text_pdf(encrypted=True), policy_for_filename("paper.pdf"))


def test_pdf_without_extractable_text_degrades_to_display_only() -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    source = BytesIO()
    writer.write(source)

    result = parse_file(source.getvalue(), policy_for_filename("scan.pdf"))

    assert result.kind == "display_only"
    assert result.document_extract is None
    assert result.warnings == ("no_extractable_text",)


def test_pdf_over_page_limit_degrades_to_display_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parsers, "MAX_PDF_PAGES", 0)

    result = parse_file(_text_pdf(), policy_for_filename("paper.pdf"))

    assert result.kind == "display_only"
    assert result.warnings == ("complexity_limit_exceeded",)


def test_docx_pptx_and_xlsx_extract_only_visible_content() -> None:
    docx_result = parse_file(_docx(), policy_for_filename("file.docx"))
    docx_text = _document_text(docx_result)
    assert "Visible paragraph" in docx_text
    assert "Cell A" in docx_text
    assert "Hidden run" not in docx_text
    assert "Deleted run" not in docx_text

    pptx_result = parse_file(_pptx(), policy_for_filename("slides.pptx"))
    pptx_text = _document_text(pptx_result)
    assert "--- Slide 1 ---" in pptx_text
    assert "Visible slide" in pptx_text
    assert "Hidden slide" not in pptx_text

    xlsx_result = parse_file(_xlsx(), policy_for_filename("book.xlsx"))
    xlsx_text = _document_text(xlsx_result)
    assert "A1: Hello" in xlsx_text
    assert "C1: =SUM(1,2) (cached: 3)" in xlsx_text
    assert "Secret" not in xlsx_text
    assert xlsx_result.warnings == ("partial_content_not_extracted",)


@pytest.mark.parametrize(
    ("source", "filename", "replacement"),
    [
        (
            _docx(),
            "empty.docx",
            {
                "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
            },
        ),
        (
            _pptx(),
            "empty.pptx",
            {
                "ppt/slides/slide1.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sld>'
            },
        ),
        (
            _xlsx(),
            "empty.xlsx",
            {
                "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
            },
        ),
    ],
)
def test_office_without_extractable_text_degrades_to_display_only(
    source: bytes,
    filename: str,
    replacement: dict[str, str | bytes],
) -> None:
    result = parse_file(_replace_zip_parts(source, replacement), policy_for_filename(filename))

    assert result.kind == "display_only"
    assert result.document_extract is None
    assert "no_extractable_text" in result.warnings


@pytest.mark.parametrize(
    ("constant", "source", "filename"),
    [
        ("MAX_DOCX_NODES", _docx(), "large.docx"),
        ("MAX_PPTX_VISIBLE_SLIDES", _pptx(), "large.pptx"),
        ("MAX_XLSX_VISIBLE_SHEETS", _xlsx(), "large.xlsx"),
        ("MAX_XLSX_NONEMPTY_CELLS", _xlsx(), "large.xlsx"),
    ],
)
def test_office_complexity_limits_degrade_to_display_only(
    monkeypatch: pytest.MonkeyPatch,
    constant: str,
    source: bytes,
    filename: str,
) -> None:
    monkeypatch.setattr(parsers, constant, 0)

    result = parse_file(source, policy_for_filename(filename))

    assert result.kind == "display_only"
    assert "complexity_limit_exceeded" in result.warnings


def test_ooxml_allows_external_hyperlinks_but_rejects_other_external_relationships() -> None:
    hyperlink_relationship = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
 Target="https://example.com/team" TargetMode="External"/>
</Relationships>'''
    linked = _replace_zip_parts(
        _xlsx(),
        {"xl/worksheets/_rels/sheet1.xml.rels": hyperlink_relationship},
    )

    result = parse_file(linked, policy_for_filename("linked.xlsx"))

    assert result.kind == "document"
    assert "external_links_not_extracted" in result.warnings

    external_data_relationship = hyperlink_relationship.replace(
        "relationships/hyperlink", "relationships/externalLink"
    )
    external_data = _replace_zip_parts(
        _xlsx(),
        {"xl/worksheets/_rels/sheet1.xml.rels": external_data_relationship},
    )
    with pytest.raises(FileProcessingError, match="external_reference_not_allowed"):
        parse_file(external_data, policy_for_filename("linked.xlsx"))


def test_ooxml_embedded_archive_is_ignored_with_warning() -> None:
    source = _replace_zip_parts(
        _docx(),
        {"word/embeddings/embedded.xlsx": _xlsx()},
    )

    result = parse_file(source, policy_for_filename("embedded.docx"))

    assert result.kind == "document"
    assert "Visible paragraph" in _document_text(result)
    assert "embedded_content_not_extracted" in result.warnings


def test_xlsx_dates_respect_both_excel_epoch_systems() -> None:
    windows = parse_file(
        _xlsx_date(date_1904=False, serial=1),
        policy_for_filename("windows-date.xlsx"),
    )
    mac = parse_file(
        _xlsx_date(date_1904=True, serial=0),
        policy_for_filename("mac-date.xlsx"),
    )

    assert "A1: 1900-01-01" in _document_text(windows)
    assert "A1: 1904-01-01" in _document_text(mac)


def test_ooxml_container_rejects_path_traversal_and_wrong_internal_type() -> None:
    traversal = _zip_bytes(
        {
            "[Content_Types].xml": _content_types(
                "word/document.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            ),
            "../word/document.xml": "<document/>",
        }
    )
    with pytest.raises(FileProcessingError, match="unsafe_archive_path"):
        parse_file(traversal, policy_for_filename("file.docx"))
    renamed = parse_file(_docx(), policy_for_filename("file.pptx"))
    assert renamed.format == "docx"
    assert renamed.warnings == ("format_corrected",)
    # When the package declares no recognizable main part, the declared
    # format's own validation still rejects the mismatch.
    ambiguous = _replace_zip_parts(
        _docx(),
        {
            "[Content_Types].xml": _content_types(
                "word/document.xml",
                "application/vnd.ms-word.document.macroEnabled.main+xml",
            )
        },
    )
    with pytest.raises(FileProcessingError, match="ooxml_type_mismatch"):
        parse_file(ambiguous, policy_for_filename("file.pptx"))


def test_restricted_parser_returns_stable_result_from_child_process() -> None:
    result = parse_in_subprocess(
        b"child process",
        FileFormat.TXT,
        timeout_seconds=5,
        memory_limit_bytes=None,
    )
    assert _document_text(result) == "child process"


def test_restricted_parser_carries_same_category_correction_and_limits() -> None:
    corrected = parse_in_subprocess(
        _png_bytes((8, 6)),
        policy_for_filename("photo.jpg"),
        timeout_seconds=10,
        memory_limit_bytes=None,
    )
    assert corrected.format == "png"
    assert corrected.media_type == "image/png"
    assert corrected.warnings == ("format_corrected",)

    with pytest.raises(FileProcessingError, match="image_dimensions_exceeded"):
        parse_in_subprocess(
            _png_bytes((8, 6)),
            policy_for_filename("photo.png"),
            limits=FileLimits(image_max_edge=7),
            timeout_seconds=10,
            memory_limit_bytes=None,
        )


def test_parent_rejects_cross_category_child_result() -> None:
    declared = policy_for_filename("photo.jpg")
    assert parsers._result_policy("png", declared=declared).format is FileFormat.PNG
    for value in ("pdf", "txt", "unknown", None):
        with pytest.raises(FileProcessingError, match="parser_failed"):
            parsers._result_policy(value, declared=declared)


def test_restricted_parser_can_run_inside_a_daemonic_celery_style_process() -> None:
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    process = context.Process(target=_parse_from_daemonic_process, args=(queue,), daemon=True)
    process.start()
    process.join(timeout=10)
    if process.is_alive():
        process.kill()
        process.join(timeout=1)

    assert process.exitcode == 0
    assert queue.get(timeout=1) == ("ok", "daemon-safe")


def test_restricted_parser_is_terminated_when_the_parent_task_is_interrupted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class InterruptedProcess:
        returncode: int | None = None

        def communicate(self, *, input: bytes | None = None, timeout: float | None = None) -> None:
            del input, timeout
            raise KeyboardInterrupt

    process = InterruptedProcess()
    terminated: list[object] = []
    monkeypatch.setattr(parsers.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(
        parsers,
        "_terminate_parser_process",
        lambda value: terminated.append(value),
    )

    with pytest.raises(KeyboardInterrupt):
        parse_in_subprocess(b"interrupted", FileFormat.TXT)

    assert terminated == [process]


def test_parser_worker_exits_before_imports_when_expected_parent_is_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(parser_worker.sys, "platform", "linux")
    monkeypatch.setattr(parser_worker.os, "getppid", lambda: 1)
    monkeypatch.setattr(parser_worker.os, "getpid", lambda: 99)
    monkeypatch.setattr(
        parser_worker.os,
        "kill",
        lambda pid, signal_number: killed.append((pid, signal_number)),
    )

    parser_worker._terminate_if_parent_dies(expected_parent_pid=42)

    assert killed == [(99, parser_worker._PARENT_DEATH_SIGNAL)]
