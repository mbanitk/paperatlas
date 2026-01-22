from __future__ import annotations

import os
from urllib.parse import urlparse

DEFAULT_MYSQL_HOST = "localhost"
DEFAULT_MYSQL_PORT = 3306
DEFAULT_MYSQL_USER = "root"
DEFAULT_MYSQL_PASSWORD = ""
DEFAULT_MYSQL_DATABASE = "paperatlas"
DEFAULT_NEO4J_BOLT_URL = "bolt://neo4j:root12345678@localhost:7687"


def get_neo4j_bolt_url() -> str:
    return os.getenv("PAPERATLAS_NEO4J_BOLT_URL", DEFAULT_NEO4J_BOLT_URL)


def get_mysql_config() -> dict:
    return {
        "host": os.getenv("PAPERATLAS_MYSQL_HOST", DEFAULT_MYSQL_HOST),
        "port": int(os.getenv("PAPERATLAS_MYSQL_PORT", DEFAULT_MYSQL_PORT)),
        "user": os.getenv("PAPERATLAS_MYSQL_USER", DEFAULT_MYSQL_USER),
        "password": os.getenv("PAPERATLAS_MYSQL_PASSWORD", DEFAULT_MYSQL_PASSWORD),
        "database": os.getenv("PAPERATLAS_MYSQL_DATABASE", DEFAULT_MYSQL_DATABASE),
    }


def parse_neo4j_bolt_url(url: str) -> tuple[str, str, str]:
    parsed = urlparse(url)
    if parsed.scheme != "bolt":
        raise ValueError(f"Unsupported Neo4j scheme: {parsed.scheme}")
    hostname = parsed.hostname or "localhost"
    port = parsed.port or 7687
    if not parsed.username or not parsed.password:
        raise ValueError("Neo4j URL must include username and password")
    uri = f"{parsed.scheme}://{hostname}:{port}"
    return uri, parsed.username, parsed.password
