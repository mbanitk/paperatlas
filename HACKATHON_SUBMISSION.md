# PaperAtlas

## Tagline
Turn research papers into a social learning feed where AI explains concepts at your expertise level

## Keywords
- Research Discovery
- Knowledge Graph
- Concept Extraction
- Personalized Learning
- AI-Powered Chat
- Academic Social Network

---

## Description

PaperAtlas transforms how researchers discover, understand, and engage with academic literature by turning dense research papers into digestible, LinkedIn-style concept feeds with AI-powered personalized explanations.

### The Problem

Today, researchers face three major challenges when working with academic papers:

1. **Information Overload**: Thousands of papers published daily, but no way to quickly identify relevant concepts
2. **Comprehension Barriers**: Papers are written at expert level, making them inaccessible to those learning new fields
3. **Isolated Learning**: Reading papers is a solitary experience with no way to discuss or explore concepts collaboratively

### Our Solution

PaperAtlas uses LLMs to extract individual **concepts** from research papers and presents each as a standalone social feed post. Instead of reading a 20-page paper, users scroll through bite-sized concept posts that explain:
- Why this concept matters
- How it connects to other ideas
- What problems it solves

The breakthrough feature is **skill-aware AI chat**: When users ask questions about a concept, the AI adjusts its explanation complexity based on their self-reported skill level. A beginner gets simple analogies; an expert gets full technical depth with equations.

### How It Works

**Phase 1 - Ingestion Pipeline:**
- Automatically fetches papers from arXiv, ACL, and other academic sources
- Downloads PDFs and extracts full text using PyMuPDF
- Stores paper metadata (authors, citations, venue) in MySQL

**Phase 2 - Concept Extraction:**
- LLM (GPT-4) analyzes each paper and extracts 5-15 distinct concepts
- Each concept gets a LinkedIn-style summary (120-200 words) designed to hook readers with a compelling question
- Concepts are stored with unique IDs and linked to source papers

**Phase 3 - Knowledge Graph:**
- Neo4j graph database connects papers → concepts → authors
- Enables graph-based recommendations ("users who engaged with this concept also liked...")
- Powers discovery of concept relationships across papers

**Phase 4 - Social Feed & AI Chat:**
- React frontend displays concepts as scrollable feed posts (like LinkedIn)
- Users can react (like, insightful, celebrate), comment, and discuss
- **AI Chat** reads the full paper + user's skill profile and provides personalized explanations
- Chat history persists so users can build deeper understanding over time

### Technical Innovation

Unlike traditional paper recommendation systems that match papers to users, PaperAtlas operates at the **concept level**. This matters because:
- One paper contains multiple concepts, each valuable to different audiences
- Concepts from different papers can be grouped and compared
- Users learn progressively: beginner concepts → intermediate → advanced

The skill-aware chat uses dynamic prompt engineering:
```python
system_prompt = f"""
User's skills:
- Machine Learning: {user.skills['ML']}  # e.g., "Intermediate"
- NLP: {user.skills['NLP']}              # e.g., "Beginner"

Adjust explanation:
- Beginner: Simple analogies, no jargon
- Intermediate: Technical terms with explanations
- Advanced: Full depth, equations, proofs
"""
```

### Impact & Metrics

**What we intentionally designed for:**
1. **Reduced Time-to-Understanding**: From 2 hours reading a paper → 5 minutes browsing concepts
2. **Democratized Knowledge**: Makes cutting-edge research accessible to learners at any level
3. **Enhanced Retention**: Social interactions (comments, discussions) reinforce learning
4. **Cross-Domain Discovery**: Concept-level matching surfaces connections across subfields

**What we intentionally excluded:**
- **No "last updated" timestamps on feed**: Security risk (enables scraping patterns) + operational commitment (implies SLA)
- **No paper ratings/reviews**: Keeps focus on learning, not judging research quality
- **No paywalled content**: Only open-access papers (arXiv, ACL Anthology) to ensure accessibility

### Real-World Use Cases

- **PhD Students**: Quickly identify relevant concepts in literature reviews
- **Industry Researchers**: Stay current with SOTA techniques without reading full papers
- **Course Instructors**: Curate concept feeds for students learning new topics
- **Career Switchers**: Bridge knowledge gaps by learning at their current skill level

PaperAtlas transforms passive paper reading into active, social, personalized learning—making research accessible, engaging, and actionable for everyone from beginners to experts.

---

## Challenge
Hack Week 2025 / AI-Powered Research Tools Category

---

## What generative AI tools did you use to build your project?

### 1. GPT-5.2 (Concept Extraction Pipeline)
- **Usage**: The core concept extraction engine that analyzes full research papers
- **Prompt Engineering**: Custom system prompt instructs GPT-4 to act as a "research scientist + LinkedIn content strategist" to extract concepts and format them as engaging social posts
- **Output**: Each paper generates 5-15 concepts with LinkedIn-style summaries (120-200 words) designed to hook readers
- **Sample extraction from "Attention Is All You Need" paper**:
  - Concept: "Scaled Dot-Product Attention"
  - Summary: "Have you ever wondered why a single square root can make attention train reliably instead of collapsing into tiny gradients? Scaled dot-product attention computes softmax(QKᵀ / √dₖ) V..."

### 2. Claude Sonnet (Skill-Aware Chat Interface)
- **Usage**: Powers the personalized explanation feature where users ask questions about papers
- **Dynamic Prompting**: System prompt includes user's skill profile (Beginner/Intermediate/Advanced) to adjust explanation complexity in real-time
- **Context Window**: Passes full paper text (~15K tokens) + chat history + user skills
- **Example**: Same question "Explain self-attention" generates different responses:
  - Beginner: "It's like each word looking at all other words to understand context..."
  - Advanced: "Self-attention computes Q, K, V matrices via linear projections, then calculates Attention(Q,K,V) = softmax(QKᵀ/√dₖ)V..."

### 3. Sentence-BERT & SciBERT (Embedding Models)
- **Usage**: Converts concepts and papers into dense vector embeddings for semantic search
- **Purpose**: Enables finding similar concepts across different papers, even if they use different terminology
- **Integration**: Embeddings stored in FAISS vector database for fast nearest-neighbor search

### 4. Safety & Quality Considerations
- **Hallucination Mitigation**: LLM extracts concepts only from provided paper text (grounded generation), never generates unsourced claims
- **Rate Limiting**: Batched processing (50 papers at a time) to manage API costs
- **Fallback Strategy**: If LLM extraction fails, heuristic extractor uses title/abstract keyword matching

### 5. Cost Optimization
- **Caching**: Common questions per paper cached to avoid redundant API calls
- **Context Truncation**: Papers limited to ~15K characters to fit context windows efficiently
- **Streaming Responses**: Chat uses streaming API for better UX (users see responses as they generate)

The AI stack transforms PaperAtlas from a simple paper database into an intelligent research assistant that understands, explains, and personalizes academic knowledge.

---

## Category
Research Tools & Knowledge Management / Educational Platform

---

## Writing Code
Yes

---

## Code Repository Link
[GitHub: paperatlas](https://github.com/yourusername/paperatlas) *(update with your actual repo URL)*

**Live Demo**: [PaperAtlas Demo](https://paperatlas.repl.co) *(if you deploy to Replit)*

---

## Creation Date
January 2025

---

## Team
**Project Owner**: [Your Name]

*(Add additional team members if applicable)*

---

## Skills Needed
Yes, this project is open to join! Looking for:
- **Frontend Engineers**: React/TypeScript expertise for UI polish
- **Backend Engineers**: FastAPI/Python for API optimization
- **ML Engineers**: Experience with graph neural networks for recommendation improvements
- **UI/UX Designers**: Help refine the LinkedIn-style feed design

---

## Technical Architecture

```
┌─────────────────────────────────────────────────────┐
│  Data Sources: arXiv, ACL, Semantic Scholar         │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│  Ingestion Pipeline (Python)                        │
│  - PDF download & parsing (PyMuPDF)                 │
│  - Metadata extraction                              │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│  Concept Extraction (GPT-4)                         │
│  - LLM-powered concept identification               │
│  - LinkedIn-style summarization                     │
└────────┬───────────────────────────┬────────────────┘
         ↓                           ↓
┌────────────────────┐    ┌──────────────────────────┐
│  MySQL Database    │    │  Neo4j Knowledge Graph   │
│  - Papers table    │    │  - Papers → Concepts     │
│  - Concepts table  │    │  - Concepts → Authors    │
│  - Users table     │    │  - Citation relationships│
└────────┬───────────┘    └──────────┬───────────────┘
         ↓                           ↓
┌─────────────────────────────────────────────────────┐
│  FastAPI Backend                                    │
│  - Feed ranking algorithm                           │
│  - Skill-aware chat (Claude API)                    │
│  - Reactions & comments API                         │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│  React Frontend (TypeScript + Tailwind)             │
│  - LinkedIn-style feed                              │
│  - AI chat interface                                │
│  - User profile & skills management                 │
└─────────────────────────────────────────────────────┘
```

---

## Demo Video Script

**[0:00-0:10]** Problem intro: "Imagine trying to keep up with 500 new ML papers published every week..."

**[0:10-0:25]** Show PaperAtlas feed: Scroll through concept posts with engaging hooks

**[0:25-0:45]** Click into a concept, show reactions/comments, click "Chat about this paper"

**[0:45-1:15]** Demo AI chat: Ask "Explain self-attention to me" → Show how answer adapts to skill level

**[1:15-1:30]** Show user profile: Skills management (set ML to "Intermediate")

**[1:30-1:45]** Return to feed, show different concepts recommended based on skills

**[1:45-2:00]** Closing: "PaperAtlas - Learn research at your level"

---

## Key Differentiators

### Q: How is this different from Google Scholar?
**A:** Google Scholar shows you papers. PaperAtlas shows you *concepts* extracted from papers, presented as social posts with AI explanations adapted to your skill level. It's the difference between a library catalog and a personalized tutor.

### Q: Why not just use ChatGPT to read papers?
**A:**
1. PaperAtlas pre-extracts concepts so you discover ideas you didn't know to ask about
2. The social feed creates serendipitous learning (like scrolling LinkedIn but for research)
3. Your skill profile makes every explanation personalized automatically
4. Community discussions around concepts reinforce learning

### Q: What's your data strategy?
**A:** We only ingest open-access papers (arXiv, ACL Anthology, PubMed Central) to ensure legal compliance and democratize knowledge. No paywalled content.

### Q: How do you measure success?
**A:**
- **Engagement**: Time spent on platform, concepts engaged with, questions asked in chat
- **Learning Outcomes**: Skill level progression (users marking skills as "Intermediate" → "Advanced")
- **Discovery**: Cross-domain concept views (e.g., NLP researcher engaging with computer vision concepts)

---

## Sample Concept Post

**Paper:** "Attention Is All You Need" (Vaswani et al., 2017)

**Concept:** Masked Self-Attention for Autoregressive Decoding

**Summary:**
How do Transformers train autoregressive decoders in parallel without letting the model "see" future tokens?

They use masked (causal) self-attention in the decoder: each position can attend only to earlier positions, never to subsequent ones. The mask is applied inside attention by setting disallowed attention logits to −∞ before the softmax. This keeps the autoregressive factorization correct while still computing attention for all positions in one parallel pass during training.

**Why this matters:**
Revisit the Transformer decoder section with causal masking in mind—it's the key step that makes "Transformer as a language model" click.

---

## Next Steps

1. **Frontend Development**: Build the LinkedIn-style UI in React
2. **Real-time Features**: Add WebSocket support for live comments/reactions
3. **Mobile App**: Native iOS/Android apps for on-the-go learning
4. **Enhanced Recommendations**: Train GNN models on user-concept interaction graphs
5. **Collaboration Features**: Team workspaces for research groups
6. **API Access**: Public API for researchers to integrate PaperAtlas into their workflows
