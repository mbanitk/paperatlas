# PaperAtlas UI Development Prompt for Replit

## Project Overview
Build a **LinkedIn-style social feed application** for academic research papers and concepts. This is the frontend + backend API for **PaperAtlas** - a research paper recommendation system that extracts concepts from papers and presents them as engaging, digestible content. I want exact linkedin feed page which i am attaching the screenshot here, the concept from the paper would normal linkedin feed. the concept will be on the feed as any other human make post on the feed. 

Sample feed are these: 
mysql> select summary from paper_concepts limit 5 \G
*************************** 1. row ***************************
summary: How do Transformers train autoregressive decoders in parallel without letting the model “see” future tokens?

They use masked (causal) self-attention in the decoder: each position can attend only to earlier positions, never to subsequent ones. The mask is applied inside attention by setting disallowed attention logits to −∞ before the softmax. This keeps the autoregressive factorization correct while still computing attention for all positions in one parallel pass during training.

Why this matters:

Revisit the Transformer decoder section with causal masking in mind—it’s the key step that makes “Transformer as a language model” click.
*************************** 2. row ***************************
summary: Can a model built for translation prove it’s truly general-purpose?

The Transformer wasn’t just a better alignment machine for machine translation; it also worked well on English constituency parsing, even when training data was limited. That result matters because parsing has different outputs, constraints, and failure modes than translation. It helped establish attention-based modeling as a reusable building block rather than a task-specific design.

Why this matters:

If you’re exploring model generalization, revisit the Transformer’s parsing results and ask what they imply about architectural primitives.
*************************** 3. row ***************************
summary: Why does translation require more than just generating the next word?

In Transformer-style encoder–decoder models, the decoder uses cross-attention to look back at the encoder’s outputs while it generates each token. Queries come from the decoder’s current state, while keys and values come from the encoded source sequence. This creates a direct, dynamic alignment between source positions and each generated output token.

Why this matters:

If you build conditional generation systems, study cross-attention as the core pattern for grounding outputs in external context.
*************************** 4. row ***************************
summary: Have you ever wondered why a single square root can make attention train reliably instead of collapsing into tiny gradients?

Scaled dot-product attention computes softmax(QKᵀ / √dₖ) V, and the √dₖ term is doing real work. As the key/query dimension grows, raw dot products grow in magnitude, which makes the softmax distribution overly sharp. Dividing by √dₖ keeps logits in a healthier range so gradients stay usable during optimization.

Why this matters:

Revisit the scaling argument in the original Transformer paper and trace how √dₖ changes the optimization behavior.
*************************** 5. row ***************************
summary: Why should modeling long-range dependencies require a long computation chain?

Self-attention makes every token able to directly reference every other token within a layer, so distant relationships don’t have to be relayed step-by-step. In RNNs, information must traverse many time steps; in CNNs, it must pass through multiple layers as receptive fields grow. With self-attention, the maximum path length between any two tokens becomes O(1) per layer, making “global context” a first-class operation.

Why this matters:

Explore the Transformer paper’s complexity and path-length comparison to internalize why self-attention scales so well for global dependencies.
5 rows in set (0.00 sec)

mysql>

---

## Core Concept
PaperAtlas extracts individual **concepts** from research papers using LLMs and presents each concept as a standalone **feed post** (like LinkedIn posts). Users can:
- Browse concepts in their feed
- Chat with papers (AI explains concepts based on user's skill level)
- Comment and discuss concepts
- Build a skill profile that personalizes their experience

---

## Technology Stack

### Backend
- **Framework**: FastAPI (Python 3.10+)
- **Database**: MySQL (existing schema provided below)
- **Graph Database**: Neo4j (optional, for recommendations)
- **LLM Integration**: OpenAI API or compatible endpoint
- **Authentication**: JWT-based auth

### Frontend
- **Framework**: React + TypeScript (or Next.js)
- **Styling**: Tailwind CSS
- **State Management**: React Query + Context API
- **UI Components**: Shadcn/ui or similar
- **Rich Text**: Markdown rendering for concept summaries

---

## Existing Database Schema

### `papers` Table
```sql
CREATE TABLE papers (
    paper_id VARCHAR(255) PRIMARY KEY,        -- e.g., "arxiv:1706.03762"
    title TEXT,                               -- e.g., "Attention Is All You Need"
    abstract LONGTEXT,
    venue VARCHAR(255),                       -- e.g., "NeurIPS"
    source VARCHAR(50),                       -- e.g., "arxiv"
    doi VARCHAR(255),
    arxiv_id VARCHAR(255),
    openalex_id VARCHAR(255),
    crossref_id VARCHAR(255),
    url TEXT,
    pdf_url TEXT,
    publication_year INT,                     -- e.g., 2017
    authors JSON,                             -- [{"name": "...", "affiliation": "..."}]
    raw_text LONGTEXT,                        -- Full paper text
    source_payload JSON
);
```

### `paper_concepts` Table
```sql
CREATE TABLE paper_concepts (
    paper_id VARCHAR(255) NOT NULL,
    concept_id VARCHAR(64) NOT NULL,          -- e.g., "concept:911239cb6e82"
    concept_name TEXT,                        -- e.g., "Masked Self-Attention"
    summary LONGTEXT,                         -- LinkedIn-style post content (120-200 words)
    source VARCHAR(50),                       -- "llm" or "heuristic"
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (paper_id, concept_id)
);
```

### Example Concept Data
```json
{
  "paper_id": "arxiv:1706.03762",
  "concept_id": "concept:a1b2c3d4e5f6",
  "concept_name": "Masked Self-Attention for Autoregressive Decoding",
  "summary": "How do Transformers train autoregressive decoders in parallel without letting the model \"see\" future tokens?\n\nThe answer is masked self-attention. During training, the decoder attends to each position, but masks prevent it from looking ahead. This lets the model learn next-token prediction without cheating.\n\nWhy this matters:\n- Enables parallel training (faster than RNNs)\n- Preserves autoregressive property (one token at a time)\n- Critical for language generation tasks\n\nThis masking trick is fundamental to GPT and other decoder-only models.\n\nIf you want to understand how modern LLMs are trained efficiently, start here.",
  "source": "llm",
  "created_at": "2025-01-28T10:30:00Z"
}
```

---

## Required Database Tables to Create

### `users` Table
```sql
CREATE TABLE users (
    user_id VARCHAR(36) PRIMARY KEY,          -- UUID
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    bio TEXT,
    profile_picture_url TEXT,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### `user_skills` Table
```sql
CREATE TABLE user_skills (
    user_id VARCHAR(36) NOT NULL,
    skill_name VARCHAR(100) NOT NULL,        -- e.g., "Machine Learning", "Beginner"
    skill_level ENUM('Beginner', 'Intermediate', 'Advanced', 'Expert') DEFAULT 'Beginner',
    PRIMARY KEY (user_id, skill_name),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
```

### `comments` Table
```sql
CREATE TABLE comments (
    comment_id VARCHAR(36) PRIMARY KEY,       -- UUID
    concept_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    parent_comment_id VARCHAR(36) NULL,       -- For nested replies
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_concept_comments (concept_id),
    INDEX idx_parent_comment (parent_comment_id)
);
```

### `reactions` Table
```sql
CREATE TABLE reactions (
    reaction_id VARCHAR(36) PRIMARY KEY,
    concept_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    reaction_type ENUM('like', 'insightful', 'celebrate', 'support', 'love') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_user_concept_reaction (user_id, concept_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_concept_reactions (concept_id)
);
```

### `paper_chats` Table
```sql
CREATE TABLE paper_chats (
    chat_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    paper_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_user_paper_chats (user_id, paper_id)
);
```

### `chat_messages` Table
```sql
CREATE TABLE chat_messages (
    message_id VARCHAR(36) PRIMARY KEY,
    chat_id VARCHAR(36) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES paper_chats(chat_id) ON DELETE CASCADE,
    INDEX idx_chat_messages (chat_id, created_at)
);
```

### `user_feed_preferences` Table
```sql
CREATE TABLE user_feed_preferences (
    user_id VARCHAR(36) PRIMARY KEY,
    topics JSON,                              -- ["Machine Learning", "NLP", "Computer Vision"]
    preferred_sources JSON,                   -- ["arxiv", "acl"]
    min_publication_year INT,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
```

---

## API Endpoints to Implement

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login (returns JWT token)
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user profile

### Feed
- `GET /api/feed` - Get personalized concept feed
  - Query params: `?limit=20&offset=0&topics=ML,NLP&sort=recent|popular`
  - Returns: Array of concept posts with paper metadata, reactions count, comment count
- `GET /api/concepts/{concept_id}` - Get single concept with full details
- `GET /api/papers/{paper_id}` - Get paper details with all concepts

### Reactions
- `POST /api/concepts/{concept_id}/reactions` - Add/update reaction
  - Body: `{"reaction_type": "like"}`
- `DELETE /api/concepts/{concept_id}/reactions` - Remove reaction
- `GET /api/concepts/{concept_id}/reactions` - Get reaction counts

### Comments
- `GET /api/concepts/{concept_id}/comments` - Get all comments (with nested replies)
- `POST /api/concepts/{concept_id}/comments` - Add comment
  - Body: `{"content": "...", "parent_comment_id": null}`
- `PUT /api/comments/{comment_id}` - Edit comment
- `DELETE /api/comments/{comment_id}` - Delete comment

### Paper Chat (AI-powered)
- `GET /api/papers/{paper_id}/chats` - Get user's chat history for this paper
- `POST /api/papers/{paper_id}/chats` - Create new chat session
- `POST /api/chats/{chat_id}/messages` - Send message to AI
  - Body: `{"message": "Explain self-attention like I'm a beginner"}`
  - Response: AI-generated explanation personalized to user's skill level
- `GET /api/chats/{chat_id}/messages` - Get chat message history

### User Profile
- `GET /api/users/{user_id}` - Get user profile
- `PUT /api/users/me` - Update current user profile
- `GET /api/users/me/skills` - Get user's skills
- `POST /api/users/me/skills` - Add/update skill
  - Body: `{"skill_name": "Machine Learning", "skill_level": "Intermediate"}`
- `DELETE /api/users/me/skills/{skill_name}` - Remove skill

### Search & Discovery
- `GET /api/search` - Search papers and concepts
  - Query params: `?q=attention+mechanism&type=concepts|papers`
- `GET /api/recommendations` - Get personalized recommendations
  - Based on user skills and interaction history

---

## Frontend UI Requirements

### 1. Main Feed (LinkedIn-style)
**Layout:**
```
┌─────────────────────────────────────────────────────┐
│  [PaperAtlas Logo]  [Search]  [Profile] [Logout]   │
├─────────┬───────────────────────────────────────────┤
│         │  ┌─────────────────────────────────────┐ │
│ Sidebar │  │ Concept Post Card                   │ │
│         │  │                                     │ │
│ - Feed  │  │ Paper: "Attention Is All You Need"  │ │
│ - My    │  │ Authors: Vaswani et al. (2017)      │ │
│   Skills│  │                                     │ │
│ - Saved │  │ [Concept Icon] Masked Self-Attention│ │
│ - Topics│  │                                     │ │
│         │  │ How do Transformers train...        │ │
│         │  │ [Read More]                         │ │
│         │  │                                     │ │
│         │  │ [💡 Like] [💬 Comment] [📄 Paper]  │ │
│         │  │ [💭 Chat]                           │ │
│         │  │                                     │ │
│         │  │ 24 reactions · 8 comments           │ │
│         │  └─────────────────────────────────────┘ │
│         │                                          │
└─────────┴──────────────────────────────────────────┘
```

**Concept Post Card Features:**
- **Paper metadata header**: Title, authors, year, venue, arXiv badge
- **Concept name**: Bold, prominent heading
- **Summary**: Full LinkedIn-style post (120-200 words)
- **Action buttons**:
  - 💡 React (like, insightful, celebrate, support, love)
  - 💬 Comment (opens comment section)
  - 📄 View Paper (opens paper detail page)
  - 💭 Chat about this concept (opens AI chat)
- **Engagement metrics**: Reaction count, comment count
- **Timestamp**: "Posted 2 hours ago"

### 2. Paper Detail Page
**URL:** `/papers/{paper_id}`

**Layout:**
```
┌─────────────────────────────────────────────────────┐
│  Paper: Attention Is All You Need                   │
│  Authors: Vaswani et al. (2017)                     │
│  Venue: NeurIPS                                     │
│  [arXiv] [PDF] [Chat with this Paper]              │
├─────────────────────────────────────────────────────┤
│  Abstract:                                          │
│  The dominant sequence transduction models...       │
├─────────────────────────────────────────────────────┤
│  Extracted Concepts (8)                             │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Concept: Masked Self-Attention              │   │
│  │ [Summary preview...]                        │   │
│  │ [💡 12] [💬 5] [View Full Concept]         │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ Concept: Multi-Head Attention               │   │
│  │ [Summary preview...]                        │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 3. AI Chat Interface (Skill-Aware)
**URL:** `/papers/{paper_id}/chat` (modal or side panel)

**Key Feature**: AI adjusts explanation complexity based on user's skill level

**Layout:**
```
┌─────────────────────────────────────────────────────┐
│  Chat: Attention Is All You Need                    │
│  Explaining at: [Intermediate] level                │
│  (Based on your ML skill: Intermediate)             │
├─────────────────────────────────────────────────────┤
│  [User]                                             │
│  Explain self-attention in simple terms             │
│                                                     │
│  [AI Assistant]                                     │
│  Self-attention is like giving each word in a       │
│  sentence the ability to "look at" every other      │
│  word to understand context. Since you're           │
│  intermediate level, think of it as computing       │
│  weighted averages where weights come from dot      │
│  products of Query-Key pairs...                     │
│                                                     │
│  [User]                                             │
│  How is this different from RNNs?                   │
│                                                     │
│  [AI Assistant]                                     │
│  Unlike RNNs that process sequentially, self-       │
│  attention allows parallel processing because...    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [Type your question...]                   [Send]   │
└─────────────────────────────────────────────────────┘
```

**Chat AI Logic:**
- **Input to LLM**:
  - Paper full text
  - User's question
  - User's skill profile (all skills + levels)
  - Chat history
- **System Prompt**:
  ```
  You are an AI assistant explaining research papers to users.

  User's skill profile:
  - Machine Learning: Intermediate
  - Deep Learning: Beginner
  - Mathematics: Advanced

  Adjust your explanation complexity based on their skills.
  For Beginner: Use analogies, avoid jargon, explain concepts from first principles
  For Intermediate: Use some technical terms, assume basic knowledge
  For Advanced/Expert: Use full technical depth, mathematical notation

  Paper content: [full paper text]
  ```

### 4. Comment Section
**Below each concept post:**

```
┌─────────────────────────────────────────────────────┐
│  Comments (8)                                       │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ @john_doe (2 hours ago)                     │   │
│  │ This concept clicked for me when I realized │   │
│  │ it's essentially weighted averaging!        │   │
│  │ [💡 5] [↩️ Reply]                           │   │
│  │                                             │   │
│  │  └─ @sarah_ml (1 hour ago)                 │   │
│  │     Exactly! And the weights come from      │   │
│  │     attention scores.                       │   │
│  │     [💡 2] [↩️ Reply]                       │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  [Add a comment...]                        [Post]   │
└─────────────────────────────────────────────────────┘
```

**Features:**
- Nested replies (one level deep)
- Like/upvote comments
- Edit/delete own comments
- Timestamp (relative: "2 hours ago")
- User avatars + usernames

### 5. User Profile & Skills Page
**URL:** `/profile`

```
┌─────────────────────────────────────────────────────┐
│  [Avatar]  John Doe                                 │
│            @john_doe                                │
│            Senior ML Engineer                       │
│                                                     │
│  [Edit Profile]                                     │
├─────────────────────────────────────────────────────┤
│  My Skills                                          │
│                                                     │
│  Machine Learning       [●●●○○] Intermediate        │
│  Deep Learning          [●●○○○] Beginner            │
│  Natural Language       [●●●●○] Advanced            │
│  Computer Vision        [●●○○○] Beginner            │
│                                                     │
│  [+ Add New Skill]                                  │
├─────────────────────────────────────────────────────┤
│  Feed Preferences                                   │
│                                                     │
│  Interested Topics:                                 │
│  [Machine Learning] [NLP] [Transformers]            │
│  [+ Add Topic]                                      │
│                                                     │
│  Sources: [arXiv] [ACL] [NeurIPS]                  │
│  Papers from: [2020 onwards]                        │
└─────────────────────────────────────────────────────┘
```

**Skill Level Selector:**
- Beginner (1-2 dots)
- Intermediate (3 dots)
- Advanced (4 dots)
- Expert (5 dots)

### 6. Sidebar Navigation
```
┌─────────────┐
│ 🏠 Feed     │
│ 🎯 Topics   │
│ 💼 My Skills│
│ 🔖 Saved    │
│ 📊 Stats    │
│ ⚙️ Settings │
└─────────────┘
```

---

## Key Features to Implement

### 1. Personalized Feed Algorithm
**Ranking based on:**
- User's skill levels (show concepts matching their expertise)
- Topics of interest
- Engagement (popular concepts)
- Recency (new concepts)
- User's interaction history

**SQL Query Example:**
```sql
SELECT
    pc.*,
    p.title, p.authors, p.publication_year,
    COUNT(DISTINCT r.reaction_id) as reaction_count,
    COUNT(DISTINCT c.comment_id) as comment_count
FROM paper_concepts pc
JOIN papers p ON pc.paper_id = p.paper_id
LEFT JOIN reactions r ON pc.concept_id = r.concept_id
LEFT JOIN comments c ON pc.concept_id = c.concept_id
WHERE p.publication_year >= 2020
GROUP BY pc.concept_id
ORDER BY (reaction_count + comment_count * 2) DESC, pc.created_at DESC
LIMIT 20 OFFSET 0;
```

### 2. Skill-Based Chat Personalization
**LLM System Prompt Template:**
```python
def build_chat_system_prompt(user_skills, paper_text):
    skill_description = "\n".join([
        f"- {skill['skill_name']}: {skill['skill_level']}"
        for skill in user_skills
    ])

    return f"""You are an AI research paper assistant.

User's Background:
{skill_description}

IMPORTANT: Adjust your explanation style:
- For Beginner skills: Use simple language, everyday analogies, avoid jargon
- For Intermediate skills: Use technical terms but explain them, assume basic knowledge
- For Advanced/Expert skills: Use full technical depth, equations, advanced terminology

Be concise, clear, and engaging. Use examples when helpful.

Paper Content:
{paper_text[:15000]}  # Truncate if too long

Answer the user's questions about this paper."""
```

### 3. Real-Time Features (Optional)
- WebSocket for live comment updates
- Real-time reaction counts
- Typing indicators in chat

### 4. Search & Filters
**Search bar features:**
- Full-text search across concept names and summaries
- Filter by: topic, year, venue, source
- Sort by: relevance, recency, popularity

---

## Implementation Steps

### Phase 1: Backend Setup
1. Set up FastAPI project structure
2. Create database tables (use SQLAlchemy ORM)
3. Implement JWT authentication
4. Build core API endpoints (feed, reactions, comments)
5. Add MySQL connection to existing PaperAtlas database

### Phase 2: Frontend Setup
1. Create React/Next.js project with TypeScript
2. Set up Tailwind CSS + component library
3. Implement authentication flow (login/register)
4. Build feed page with concept cards
5. Add paper detail page

### Phase 3: Interactive Features
1. Implement comment system (with nested replies)
2. Add reaction system (like LinkedIn reactions)
3. Build user profile & skills management

### Phase 4: AI Chat
1. Integrate OpenAI API or compatible LLM
2. Build chat interface (modal or side panel)
3. Implement skill-based prompt engineering
4. Add chat history persistence

### Phase 5: Personalization
1. Build feed ranking algorithm
2. Add recommendation system
3. Implement user preferences
4. Add saved/bookmarked concepts

### Phase 6: Polish
1. Add responsive design (mobile-friendly)
2. Implement infinite scroll on feed
3. Add loading states and error handling
4. Optimize performance (caching, pagination)

---

## Example API Response Formats

### Feed Response
```json
{
  "concepts": [
    {
      "concept_id": "concept:a1b2c3d4e5f6",
      "concept_name": "Masked Self-Attention for Autoregressive Decoding",
      "summary": "How do Transformers train autoregressive...",
      "source": "llm",
      "created_at": "2025-01-28T10:30:00Z",
      "paper": {
        "paper_id": "arxiv:1706.03762",
        "title": "Attention Is All You Need",
        "authors": [
          {"name": "Ashish Vaswani", "affiliation": "Google Brain"}
        ],
        "publication_year": 2017,
        "venue": "NeurIPS",
        "arxiv_id": "1706.03762"
      },
      "engagement": {
        "reaction_count": 24,
        "comment_count": 8,
        "user_reaction": "like"  // null if not reacted
      }
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 450,
    "has_more": true
  }
}
```

### Chat Message Response
```json
{
  "message_id": "msg-123",
  "role": "assistant",
  "content": "Self-attention is like giving each word in a sentence the ability to \"look at\" every other word to understand context. Since you're at an intermediate level, think of it as computing weighted averages where weights come from dot products of Query-Key pairs. The Values are what get averaged. This parallelizes computation unlike RNNs, making training much faster.",
  "created_at": "2025-01-28T11:00:00Z"
}
```

---

## Environment Variables
```env
# Database
DATABASE_URL=mysql://root:password@localhost:3306/paperatlas

# JWT
JWT_SECRET=your-secret-key-here
JWT_ALGORITHM=HS256
JWT_EXPIRATION_HOURS=24

# LLM
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4
OPENAI_BASE_URL=https://api.openai.com/v1

# App
FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:8000
```

---

## Success Criteria

### MVP Must-Haves:
✅ User authentication (register, login, logout)
✅ Feed of concepts (with pagination)
✅ Concept post cards (LinkedIn-style)
✅ Reactions (at least "like")
✅ Comments (with nested replies)
✅ Paper detail page
✅ AI chat (skill-aware explanations)
✅ User profile with skills management

### Nice-to-Haves:
- Real-time updates (WebSockets)
- Advanced search & filters
- Recommendations engine
- Saved/bookmarked concepts
- User activity feed
- Following other users
- Sharing concepts externally

---

## Design References
- **LinkedIn** (for feed layout and post cards)
- **Twitter/X** (for comment threads)
- **ChatGPT** (for AI chat interface)
- **Medium** (for reading experience)

---

## Additional Notes

1. **Performance**: Use database indexing on frequently queried fields (concept_id, paper_id, user_id)

2. **Security**:
   - Hash passwords with bcrypt
   - Validate all user inputs
   - Implement rate limiting on API endpoints
   - Sanitize user-generated content (comments)

3. **LLM Cost Optimization**:
   - Cache common questions per paper
   - Limit paper text to ~15,000 chars for context window
   - Implement streaming responses for better UX

4. **Accessibility**:
   - ARIA labels for screen readers
   - Keyboard navigation support
   - High contrast mode option

5. **Analytics** (optional):
   - Track which concepts get most engagement
   - Monitor chat usage patterns
   - A/B test feed ranking algorithms

---

## Getting Started Command
```bash
# Clone or create new Replit project
# Install dependencies
pip install fastapi uvicorn sqlalchemy pymysql python-jose[cryptography] passlib[bcrypt] python-multipart openai

npm create vite@latest frontend -- --template react-ts
cd frontend && npm install
npm install tailwindcss @tanstack/react-query axios react-router-dom

# Run backend
uvicorn main:app --reload --port 8000

# Run frontend
cd frontend && npm run dev
```

---

## Questions for Developer

Before starting, clarify:
1. Do you want Next.js (SSR) or Vite+React (SPA)?
2. Should we use existing PaperAtlas API or build from scratch?
3. Any preferred UI component library? (Shadcn/ui, Material-UI, Chakra?)
4. OAuth providers needed? (Google, GitHub, etc.)
5. Mobile app needed or web-only?

---

**This prompt provides everything needed to build a production-ready LinkedIn-style UI for PaperAtlas!** 🚀
