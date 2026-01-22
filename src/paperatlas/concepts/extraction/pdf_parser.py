from __future__ import annotations

import logging
from typing import Optional
from xml.etree import ElementTree

import httpx

logger = logging.getLogger(__name__)


class PdfParser:
    def __init__(self, strategy: str = "auto", grobid_url: str = "http://localhost:8070") -> None:
        self.strategy = strategy
        self.grobid_url = grobid_url.rstrip("/")

    def parse_bytes(self, data: bytes) -> str:
        if self.strategy == "pymupdf":
            return _parse_pdf_pymupdf(data)
        if self.strategy == "grobid":
            return _parse_pdf_grobid(data, self.grobid_url)
        try:
            return _parse_pdf_pymupdf(data)
        except RuntimeError:
            return _parse_pdf_grobid(data, self.grobid_url)


def _parse_pdf_pymupdf(data: bytes) -> str:
    try:
        import fitz  # type: ignore
    except Exception as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "PyMuPDF is required for PDF parsing. Install it with `pip install pymupdf`."
        ) from exc
    doc = fitz.open(stream=data, filetype="pdf")
    pages = []
    for page in doc:
        pages.append(page.get_text())
    return "\n".join(pages).strip()


def _parse_pdf_grobid(data: bytes, base_url: str) -> str:
    url = f"{base_url}/api/processFulltextDocument"
    response = httpx.post(url, files={"input": ("paper.pdf", data, "application/pdf")}, timeout=60.0)
    if response.status_code != 200:
        raise RuntimeError(f"GROBID failed with status {response.status_code}")
    return _extract_text_from_tei(response.text)


def _extract_text_from_tei(tei_xml: str) -> str:
    if not tei_xml:
        return ""
    try:
        root = ElementTree.fromstring(tei_xml)
    except ElementTree.ParseError:
        logger.warning("Failed to parse GROBID TEI XML")
        return ""
    return " ".join(text.strip() for text in root.itertext() if text.strip())
