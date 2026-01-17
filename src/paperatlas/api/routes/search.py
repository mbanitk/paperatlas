from fastapi import APIRouter

router = APIRouter()

@router.get("/")
def search(query: str):
    return {"query": query}
