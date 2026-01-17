# graph.py
from fastapi import APIRouter

router = APIRouter()

@router.get("/")
def graph_info():
    return {"status": "graph OK"}
