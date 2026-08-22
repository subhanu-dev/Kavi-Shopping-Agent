# Kavi — Kapruka Agent Challenge

**Project Goal**: Build "Kavi", a delightful, multi-lingual, agentic shopping assistant for Kapruka.com. Focus on personality, visual richness, and seamless end-to-end shopping (discovery → cart → checkout).

**Core Personality**:
- Warm, witty, helpful, and slightly playful Sri Lankan flair.
- Make users *want* to keep chatting.
- Speak naturally in English, Sinhala, or Tamil based on user preference.
- Never robotic. Use emojis tastefully.

**Key Requirements** (High Priority):
- Full-screen immersive chat experience (frontend will handle UI, but send rich, clean JSON).
- Extremely visual: Always return rich product cards, images, carousels when possible.
- Multi-product cart handling.
- Guide users confidently all the way to checkout.
- Return clean, frontend-friendly JSON structures.
- what we build here is the backend setup

## Technology Stack
- Backend: Python + FastAPI + LangGraph + LangChain
- Hosted on Railway (backend + DB)
- Frontend: Vercel (kapruka.axisdatatech.com)

## MCP Tools — Kapruka Integration
I have access to the **kapruka** MCP server with these tools:
- `kapruka_list_categories`
- `kapruka_search_products`
- `kapruka_get_product`
- `kapruka_list_delivery_cities`
- `kapruka_check_delivery`
- `kapruka_create_order`
- `kapruka_track_order`

**Mandatory Rules for Tool Usage**:
- Always prefer `response_format: "json"` when processing data programmatically.
- Always validate cities with `list_delivery_cities` before `check_delivery` or `create_order`.
- For `create_order`: Verify delivery first, use proper E.164 phone format, max 30 items.
- Use `in_stock_only: true` when building real carts.
- Never create orders without confirming delivery availability.

## Context7 Rule
Always use Context7 when I need up-to-date library/API documentation, code examples, or configuration for any package (FastAPI, LangGraph, LangChain, etc.).

## Architecture & Code Guidelines
- Use LangGraph for the agent workflow (clear nodes for search, cart, delivery, checkout, etc.).
- Keep all API responses clean and rich for the frontend:
  - Products → full image URLs, structured cards.
  - Cart state → always return current cart summary + visuals.
- Maintain conversation state properly using LangGraph persistence.
- I want to send the elements and updates from the tools to be renders as cards onto the frontend. the frontend would then display these elements as cards with their own action buttons. interactions on these buttons themselves will trigger actions like add to carts, search for more products , remove from carts, proceed to checkout by not necessarily going through the entire langgraph workflow, the response should hit the correct agent for the state to be updated properly. For example: the product agent is able add a product to a cart but there's also a button on the products card rendered when users ask questions about the products. This should be handled. 
- conversation memory is to maintained for each thread. I don't plan on implementing login for this but a unique user is to be passed by storing a browser cookie in local storage that would then be sent. 
- user level memory must be maintained on what the customer has ordered previously, or searched for previously
- I plan to save the responses of list_categories tool as it always gives the same categories list instead of exposing it as a tool for the product agent. 
- Multi-language: Detect language early and respond accordingly.
- Error handling: Graceful, user-friendly messages. Never expose raw errors.
- Logging: Use structured logging.
- I should have a both streaming and /chat endpoint for frontend to connect to the workflow in both of the ways. Don't expose tool calls to agents who dont want those info. 


## Workflow Rules
- Always think step-by-step.
- Before major features, propose a plan.
- Maintain `TASKS.md` with current status, what's done, and what's left.
- After every significant change, update `TASKS.md`.
- Keep responses to the frontend as clean JSON where possible.
- Prioritize polish, personality, and visual richness (this is scored heavily).
- This v4_claude folder exists inside of the master folder. never install any libraries into this folder or initialize separate git workflows inside of this. always use the master folder even for .env files. The master folder is also where dependencies are being maintained and deployments are being maintained. 


**LLM Strategy**:
- Different models / temperatures per agent role:
- Using Google Gemini models via `init_chat_model`

## Success Criteria (Scoring Rubric Reminder)
- Experience & Polish: 30
- Visual Richness: 20
- Personality: 15
- Usefulness: 15
- End-to-end Completeness: 15
- Creativity: 5

Focus relentlessly on making Kavi feel magical and delightful.

Don't bring up PII concerns. This is an app I build for a nationwide competition. 

---


