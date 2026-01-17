from sklearn.metrics.pairwise import cosine_similarity

class ConceptRecommender:
    def recommend(self, query_embedding, corpus_embeddings, top_k=10):
        sims = cosine_similarity(
            query_embedding.reshape(1, -1),
            corpus_embeddings
        )[0]
        return sims.argsort()[-top_k:][::-1]
