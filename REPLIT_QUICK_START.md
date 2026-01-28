# PaperAtlas UI - Quick Start for Replit

## What to Build
A **LinkedIn-style social feed** for research paper concepts with:
- 📰 Feed of concept posts (like LinkedIn posts)
- 💬 AI chat that explains papers at user's skill level
- 💭 Comments & reactions on concepts
- 👤 User profiles with skill levels

---

## Stack
**Backend:** FastAPI + MySQL + OpenAI API
**Frontend:** React + TypeScript + Tailwind CSS

---

## Database Schema (Execute These)

```sql
-- Users
CREATE TABLE users (
    user_id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    full_name VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User Skills (for personalized chat)
CREATE TABLE user_skills (
    user_id VARCHAR(36) NOT NULL,
    skill_name VARCHAR(100) NOT NULL,
    skill_level ENUM('Beginner', 'Intermediate', 'Advanced', 'Expert'),
    PRIMARY KEY (user_id, skill_name),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Comments
CREATE TABLE comments (
    comment_id VARCHAR(36) PRIMARY KEY,
    concept_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    content TEXT NOT NULL,
    parent_comment_id VARCHAR(36) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Reactions (like LinkedIn)
CREATE TABLE reactions (
    reaction_id VARCHAR(36) PRIMARY KEY,
    concept_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    reaction_type ENUM('like', 'insightful', 'celebrate') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY (user_id, concept_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Paper Chats
CREATE TABLE paper_chats (
    chat_id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    paper_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Chat Messages
CREATE TABLE chat_messages (
    message_id VARCHAR(36) PRIMARY KEY,
    chat_id VARCHAR(36) NOT NULL,
    role ENUM('user', 'assistant') NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES paper_chats(chat_id) ON DELETE CASCADE
);
```

---

## Key API Endpoints to Build

### Auth
- `POST /api/auth/register` - Register user
- `POST /api/auth/login` - Login (returns JWT)
- `GET /api/auth/me` - Get current user

### Feed
- `GET /api/feed?limit=20&offset=0` - Get concept feed
  ```json
  {
    "concepts": [
      {
        "concept_id": "concept:abc123",
        "concept_name": "Masked Self-Attention",
        "summary": "How do Transformers train...",
        "paper": {
          "paper_id": "arxiv:1706.03762",
          "title": "Attention Is All You Need",
          "authors": [{"name": "Vaswani et al."}],
          "publication_year": 2017
        },
        "engagement": {
          "reaction_count": 24,
          "comment_count": 8
        }
      }
    ]
  }
  ```

### Interactions
- `POST /api/concepts/{concept_id}/reactions` - Like/react
- `GET /api/concepts/{concept_id}/comments` - Get comments
- `POST /api/concepts/{concept_id}/comments` - Add comment

### AI Chat (The Magic!)
- `POST /api/papers/{paper_id}/chats` - Start chat
- `POST /api/chats/{chat_id}/messages` - Send message

  **Backend Logic:**
  ```python
  # Get user skills
  skills = db.query(UserSkill).filter(user_id=current_user.id).all()

  # Build personalized prompt
  system_prompt = f"""
  You are explaining this research paper to a user with:
  - Machine Learning: {skills['ML']} level
  - Deep Learning: {skills['DL']} level

  Adjust complexity accordingly:
  - Beginner: Simple analogies, no jargon
  - Intermediate: Technical terms with explanations
  - Advanced/Expert: Full technical depth

  Paper: {paper.title}
  {paper.raw_text[:15000]}
  """

  # Call OpenAI
  response = openai.chat.completions.create(
      model="gpt-4",
      messages=[
          {"role": "system", "content": system_prompt},
          {"role": "user", "content": user_question}
      ]
  )
  ```

### User Profile
- `GET /api/users/me/skills` - Get skills
- `POST /api/users/me/skills` - Add skill
  ```json
  {
    "skill_name": "Machine Learning",
    "skill_level": "Intermediate"
  }
  ```

---

## Frontend UI Components

### 1. Feed Page (Main)
```tsx
// ConceptCard.tsx
<div className="bg-white rounded-lg shadow p-6 mb-4">
  {/* Paper Header */}
  <div className="flex items-center mb-3">
    <div className="text-sm text-gray-600">
      <a href={`/papers/${paper_id}`}>{paper.title}</a>
      <span className="ml-2">{paper.authors[0].name} et al.</span>
      <span className="ml-2">({paper.publication_year})</span>
    </div>
  </div>

  {/* Concept */}
  <h3 className="text-xl font-bold mb-3">{concept_name}</h3>
  <p className="text-gray-800 whitespace-pre-line mb-4">{summary}</p>

  {/* Actions */}
  <div className="flex items-center gap-4 text-sm text-gray-600">
    <button onClick={handleReact}>💡 {reaction_count}</button>
    <button onClick={toggleComments}>💬 {comment_count}</button>
    <button onClick={openChat}>💭 Chat</button>
    <a href={`/papers/${paper_id}`}>📄 Paper</a>
  </div>

  {/* Comments Section */}
  {showComments && <CommentSection conceptId={concept_id} />}
</div>
```

### 2. AI Chat Modal
```tsx
// ChatModal.tsx
<Modal open={isOpen}>
  <div className="bg-white rounded-lg p-6 max-w-2xl">
    <h2>Chat: {paper.title}</h2>
    <div className="text-sm text-gray-600 mb-4">
      Explaining at: <span className="font-bold">{userSkillLevel}</span> level
    </div>

    {/* Messages */}
    <div className="h-96 overflow-y-auto mb-4">
      {messages.map(msg => (
        <div key={msg.id} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
          <div className="inline-block bg-gray-100 rounded p-3 mb-2">
            {msg.content}
          </div>
        </div>
      ))}
    </div>

    {/* Input */}
    <input
      type="text"
      placeholder="Ask about this paper..."
      onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
    />
  </div>
</Modal>
```

### 3. User Profile
```tsx
// ProfilePage.tsx
<div className="max-w-4xl mx-auto p-6">
  <h1 className="text-2xl font-bold mb-6">My Skills</h1>

  {skills.map(skill => (
    <div key={skill.skill_name} className="flex items-center justify-between mb-4">
      <span className="font-medium">{skill.skill_name}</span>
      <div className="flex gap-1">
        {[1,2,3,4,5].map(level => (
          <div
            key={level}
            className={level <= skillLevelMap[skill.skill_level]
              ? 'w-3 h-3 bg-blue-500 rounded-full'
              : 'w-3 h-3 bg-gray-300 rounded-full'}
          />
        ))}
      </div>
      <span className="text-gray-600">{skill.skill_level}</span>
    </div>
  ))}

  <button onClick={addSkill}>+ Add Skill</button>
</div>
```

---

## SQL Query for Feed

```sql
SELECT
    pc.concept_id,
    pc.concept_name,
    pc.summary,
    pc.source,
    pc.created_at,
    p.paper_id,
    p.title,
    p.authors,
    p.publication_year,
    p.venue,
    COUNT(DISTINCT r.reaction_id) as reaction_count,
    COUNT(DISTINCT c.comment_id) as comment_count
FROM paper_concepts pc
JOIN papers p ON pc.paper_id = p.paper_id
LEFT JOIN reactions r ON pc.concept_id = r.concept_id
LEFT JOIN comments c ON pc.concept_id = c.concept_id
WHERE p.publication_year >= 2020
GROUP BY pc.concept_id
ORDER BY pc.created_at DESC
LIMIT 20 OFFSET 0;
```

---

## Environment Setup

```bash
# Backend
pip install fastapi uvicorn sqlalchemy pymysql python-jose[cryptography] passlib[bcrypt] openai

# Frontend
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install tailwindcss @tanstack/react-query axios react-router-dom
```

`.env` file:
```env
DATABASE_URL=mysql://root:password@localhost:3306/paperatlas
JWT_SECRET=your-secret-key
OPENAI_API_KEY=sk-...
```

---

## MVP Features Priority

**Phase 1 (Week 1):**
✅ Authentication (register, login)
✅ Feed page with concept cards
✅ Paper detail page
✅ Basic styling (Tailwind)

**Phase 2 (Week 2):**
✅ Reactions (like button)
✅ Comments (basic, no nesting)
✅ User profile page

**Phase 3 (Week 3):**
✅ AI Chat with skill-based responses
✅ Skills management
✅ Nested comments

**Phase 4 (Polish):**
✅ Search & filters
✅ Infinite scroll
✅ Mobile responsive

---

## Testing the AI Chat

**Example user question:**
> "Explain self-attention to me"

**AI response (Beginner level):**
> "Self-attention is like each word in a sentence being able to 'look at' all other words to understand the full context. Imagine reading a book where every word has connections to related words - that's what self-attention does automatically!"

**AI response (Advanced level):**
> "Self-attention computes Q, K, V matrices from input embeddings, then calculates attention scores via scaled dot-product: Attention(Q,K,V) = softmax(QK^T/√d_k)V. This allows each position to attend to all positions with O(n²) complexity but parallelizable computation."

---

## Quick Design Tips

**Color Scheme (LinkedIn-inspired):**
- Primary: `#0A66C2` (LinkedIn blue)
- Background: `#F3F2EF`
- Cards: `#FFFFFF`
- Text: `#000000` / `#666666`

**Fonts:**
- Headers: `font-family: 'Inter', sans-serif` (bold)
- Body: `font-family: 'Inter', sans-serif` (regular)

**Card Shadows:**
```css
box-shadow: 0 0 0 1px rgba(0,0,0,0.1), 0 2px 3px rgba(0,0,0,0.1);
```

---

## Sample Data (For Testing)

```json
{
  "paper_id": "arxiv:1706.03762",
  "title": "Attention Is All You Need",
  "concept_name": "Masked Self-Attention",
  "summary": "How do Transformers train autoregressive decoders in parallel without letting the model \"see\" future tokens?\n\nThe answer is masked self-attention. During training, the decoder attends to each position, but masks prevent it from looking ahead. This lets the model learn next-token prediction without cheating.\n\nWhy this matters:\n- Enables parallel training (faster than RNNs)\n- Preserves autoregressive property (one token at a time)\n- Critical for language generation tasks\n\nThis masking trick is fundamental to GPT and other decoder-only models.\n\nIf you want to understand how modern LLMs are trained efficiently, start here."
}
```

---

## Next Steps

1. **Create Replit Project**: Python + React template
2. **Set up MySQL**: Use Replit's database or external MySQL
3. **Run SQL scripts**: Create all tables
4. **Build backend**: FastAPI with endpoints above
5. **Build frontend**: React components listed above
6. **Connect OpenAI**: Add API key to env
7. **Test**: Register user → Add skills → Browse feed → Chat with paper

---

**Start with authentication and feed, then add chat + comments. The skill-based AI chat is the killer feature!** 🚀
