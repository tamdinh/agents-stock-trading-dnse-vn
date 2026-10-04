# AGENTS.md

## Runtime & Toolchain

- **Runtime:** Bun (not Node.js)
- **Language:** TypeScript with `verbatimModuleSyntax: true`
- **Import convention:** Use `.ts` extensions for local imports (Bun resolves them). External packages keep their natural import paths.
- **Type check:** `bun run tsc --noEmit`
- **No build step:** Bun runs `.ts` directly

## Quick Commands

```bash
bun install              # Install dependencies
bun run start            # Run main agent (CLI chatbot)
bun run start.ts         # Run all services (MCP + Agent)
bun run start.ts --mcp   # Run MCP server only
bun run start.ts --agent # Run agent only
bun run tsc --noEmit     # Type check
```

## Architecture

```
src/
├── index.ts              # Entry point - CLI chatbot
├── graph/
│   ├── state.ts          # State annotations
│   ├── trading-graph.ts  # Main graph
│   ├── conditions.ts     # Conditional edges
│   ├── fault-tolerance.ts # Retry + error handling
│   ├── interrupts.ts     # Human-in-the-loop
│   ├── stores.ts         # Shared state stores
│   └── subgraphs/        # Subgraphs (analysts, debate, risk)
├── checkpoint/
│   ├── manager.ts        # SQLite checkpoint
│   └── time-travel.ts    # Time-travel utilities
├── memory/               # Decision logs
├── agents/               # Analysts, Researchers, Managers
├── tools/                # Direct tools (DynamicTool)
│   ├── dnse/             # Shared DNSE server
│   ├── market-data/      # 10 DNSE tools
│   ├── trading/          # Placeholder
│   ├── account/          # Placeholder
│   └── web/              # Tavily + Firecrawl
├── llm/                  # Multi-provider LLM
└── prompts.ts            # System prompts
```

## Key Patterns

**Tool groups:** market-data, trading (placeholder), account (placeholder), web
**LLM tiers:** `quick` (analysts, researchers) vs `deep` (research manager, portfolio manager)
**Providers:** NVIDIA NIM, OpenAI, Anthropic, Google, Ollama, DeepSeek
**Graph flow:** Analysts → Bull/Bear Debate → Research Manager → Trader → Risk Debate → Portfolio Manager

## LangGraph Features

- **Subgraphs:** Tách graph thành analysts, debate, risk subgraphs
- **Checkpoints:** In-memory checkpoints for interrupts/resume while the process is running; cleared on exit
- **Time-travel:** Quay lại trạng thái bất kỳ
- **Interrupts:** Dừng graph để user confirm
- **Fault tolerance:** Retry + error handling tự động
- **Stores:** Shared state cho multi-session

## Environment

Required in `.env`:
- `DNSE_API_KEY`, `DNSE_API_SECRET` - DNSE OpenAPI credentials
- `LLM_API_KEY` or `NVIDIA_API_KEY` - LLM provider key
- `TAVILY_API_KEY` (optional) - For web search
- `FIRECRAWL_API_URL` (optional) - Default `http://localhost:3002`

## Gotchas

- `src/mcp/` and `src/mcp-client.ts` are excluded from type checking (reserved for standalone MCP project)
- `firecrawl/` directory is a git submodule, excluded from `.gitignore`
- `mcp-standalone/` is a separate MCP project, not part of main build
- LangGraph checkpoint state is in memory and is cleared when the process exits
- Memory logs saved to `.memory/` directory
