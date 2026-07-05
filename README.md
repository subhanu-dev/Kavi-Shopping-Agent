# Kavi - Kapruka-Shopping-Agent 🛍️

Meet Kavi - Your AI Assistant to the largest shopping marketplace in Sri Lanka. Powered by Kapruka MCP


### System Architecture

Technologies Used

Backend
Python , FastAPI , LangGraph , LangChain, Postgress, Hosted on Railway

Frontend
HTML, CSS, JS (Free from Frameworks), Hosted on Vercel



### AI architecture


### Models used

- Router Agent Node : GPT OSS 20B using Groq, Fallback : Gemini 2.55-flash-lite
- Subagents
  Product agent - GPT-5.4-mini
  Order agent - Gemini-2.5 flash-lite

- Concierge Agent (Kavi Agent) - Gemini-3.5-flash


Every conversational path funnels through **kavi_agent**, the single voice the customer ever hears. Specialist agents write terse internal "status notes" that Kavi rewrites from scratch.




