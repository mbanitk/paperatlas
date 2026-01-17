from fastapi import FastAPI
from paperatlas.api.routes import search, recommend, graph

app = FastAPI(title="PaperAtlas")

app.include_router(search.router, prefix="/search")
app.include_router(recommend.router, prefix="/recommend")
app.include_router(graph.router, prefix="/graph")
