from __future__ import annotations

import logging

from paperatlas.concepts.extraction.generate import main


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
