# Week 09 Lab — Team Project Kickoff

Starting this week's lab session, you will begin the team project. This document covers (1) how to form your team and (2) the project topic and requirements.

---

## Part 1. Forming the Project Team

### Team Composition Rules
- **Team size**: 3–4 members per team (adjustable in consultation with the TA / instructor)
- **Roles**: Distribute the following roles within the team as you see fit.
  - **Frontend** lead
  - **Backend / Server** lead
  - **LLM integration / Prompt engineering** lead
  - **PM** (planning, scheduling, documentation, presentation coordination)
  - One person may take on multiple roles, and one role may be shared by multiple members.
- **Team name**: Choose freely.

### Team Submission
- Finalize your team during class and submit the following:
  1. Team name
  2. Member list (name / student ID / email)
  3. Team GitHub repository URL (Public)
  4. Role assignment table

---

## Part 2. Project Topic

### Topic
- **The topic is open** — as long as it satisfies all of the requirements below.

### Requirements
1. The project must be a **web-based application that uses an LLM**.
2. The project must be implemented as a **Frontend + Server (Backend)** architecture.
   - Frontend framework/library: free choice (e.g., React, Vue, Svelte, plain HTML/JS, etc.)
   - Backend framework/language: free choice (e.g., FastAPI, Flask, Express, Spring, etc.)
3. **Public deployment is optional.**
   - Running locally is sufficient.
   - You may deploy publicly if you wish (e.g., Vercel, Render, AWS, GCP, etc.).
4. The code **must be pushed to GitHub**.
   - Use a public repository.
   - The README must include setup instructions, how to run the app, and demo screenshots/links.
5. The project **must apply algorithm concepts learned in this course** somewhere in the implementation.
   - Examples: sorting/searching, divide & conquer, greedy, dynamic programming, graph algorithms, hashing, trees (BST/RBT/B-Tree), etc.
   - **The more course concepts you apply, the better.** Document where and how each concept is used (in the README and the technical report).

### LLM — Solar
- The project must use **Upstage Solar** as its LLM.
- API access application: <https://www.upstage.ai/events/ai-initiative-2025-ko>
  - Apply at the link above first. Once approved, you will receive an API key.

### Additional Free API — NVIDIA NIM
- By applying for the **NVIDIA NIM (NVIDIA Inference Microservices)** program, you can access several model APIs **for free (though somewhat slow)**.
- Useful for embeddings, auxiliary LLMs, multimodal models, etc., when you need capabilities beyond Solar.

### Frontend Tip — Use AI Tools Aggressively
- If frontend UI/design feels burdensome, use AI tools to quickly draft mockups and generate code.
  - **Google AI Studio** — UI prototypes / code snippets
  - **Claude Design (Artifacts)** — preview components, layouts, and interactions while iterating quickly
  - Others such as v0, Lovable, Bolt, Figma Make are also welcome
- Don't use generated code as-is — refine it to match your team's tech stack and design consistency.

### Development Tool Support — Claude Code 1-Month License
- We will distribute **one 1-month Claude Code license per team**.
- Use it actively for coding, refactoring, debugging, testing, documentation, and more.
- Distribution method, schedule, and account-registration steps will be announced separately.

---

## Final Deliverables

By the end of the project, the following four items must all be ready.

| # | Deliverable | Description |
|---|-------------|-------------|
| 1 | **Application** | A working product + full source code (GitHub repository) |
| 2 | **Technical Report** | System architecture, tech stack, how the LLM is used, key implementation details, and limitations |
| 3 | **Development Process Document** | Planning → scheduling → execution → retrospective. Includes meeting notes, timelines, per-role progress, issue tracking, etc. |
| 4 | **Presentation Slides** | Slides for the final presentation |

### Presentation
- The presentation will take place **during class**.
- **Both the slides and the presentation itself must be in English.**

---

## Recommended Workflow

1. **Week 09**: Finalize team, brainstorm topic, create GitHub repo, apply for Solar / NIM APIs
2. **Following weeks**: Proposal → prototype → MVP → feature polish → report & slide preparation
3. **Final week**: Presentation (in English)

---

## Checklist (Before End of Week 09)
- [ ] Team formed and submitted
- [ ] Team GitHub repository created (Public)
- [ ] Initial topic statement (one-paragraph summary + 3 core features)
- [ ] Solar API applied (<https://www.upstage.ai/events/ai-initiative-2025-ko>)
- [ ] NVIDIA NIM program applied (optional, recommended)
- [ ] One team representative ready to receive the Claude Code 1-month license (watch for announcement)
