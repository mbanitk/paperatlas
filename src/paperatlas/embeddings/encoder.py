from typing import List
import torch

class TextEncoder:
    def __init__(self, model):
        self.model = model

    def encode(self, texts: List[str]) -> torch.Tensor:
        with torch.no_grad():
            return self.model.encode(texts, convert_to_tensor=True)
