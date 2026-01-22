from __future__ import annotations

from typing import Any, Iterable, Optional


class Neo4jClient:
    def __init__(self, uri: str, user: str, password: str) -> None:
        try:
            from neo4j import GraphDatabase  # type: ignore
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "neo4j driver is required for graph storage. Install it with `pip install neo4j`."
            ) from exc
        self._driver = GraphDatabase.driver(uri, auth=(user, password))

    def close(self) -> None:
        self._driver.close()

    def execute_write(self, query: str, parameters: Optional[dict] = None) -> Any:
        with self._driver.session() as session:
            return session.execute_write(lambda tx: tx.run(query, parameters or {}).data())

    def execute_read(self, query: str, parameters: Optional[dict] = None) -> Any:
        with self._driver.session() as session:
            return session.execute_read(lambda tx: tx.run(query, parameters or {}).data())

    def execute_many(self, query: str, rows: Iterable[dict]) -> None:
        with self._driver.session() as session:
            session.execute_write(lambda tx: tx.run(query, {"rows": list(rows)}))
