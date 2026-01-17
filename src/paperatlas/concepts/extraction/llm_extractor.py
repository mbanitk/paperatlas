from typing import List, Dict

class LLMConceptExtractor:
    def extract(self, text: str) -> List[Dict]:
        """
        Extracts concepts from paper text.

        Returns:
        [
          {
            "name": "...",
            "type": "discussed|proposed",
            "summary": "...",
            "bullets": [...]
          }
        ]
        """
        raise NotImplementedError
