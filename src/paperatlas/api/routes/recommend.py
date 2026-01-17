from fastapi import APIRouter

router = APIRouter()

@router.get("/")
def recommend_papers(query: str):
    return {"query": query, "recommendations": []}
