# DNSE TradingAgents

Hệ thống phân tích đầu tư chứng khoán Việt Nam với kiến trúc 5 tầng, sử dụng LangGraph.js.

## Kiến trúc

```
┌─────────────────────────────────────────────────────────────────┐
│                    TradingAgents Graph                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              ANALYSTS SUBGRAPH                          │   │
│  │  Market → Sentiment → News → Fundamentals               │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              DEBATE SUBGRAPH                            │   │
│  │  Bull ↔ Bear (N rounds)                                 │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│                    Research Manager                             │
│                          │                                      │
│                          ▼                                      │
│                        Trader                                   │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              RISK SUBGRAPH                              │   │
│  │  Aggressive ↔ Conservative ↔ Neutral                    │   │
│  └───────────────────────┬─────────────────────────────────┘   │
│                          │                                      │
│                          ▼                                      │
│                    Portfolio Manager                            │
└─────────────────────────────────────────────────────────────────┘
```

## Cấu trúc thư mục

```
dnse/
├── src/
│   ├── index.ts              # Entry point
│   ├── graph/                # LangGraph
│   │   ├── state.ts          # State annotations
│   │   ├── trading-graph.ts  # Main graph
│   │   ├── conditions.ts     # Conditional edges
│   │   ├── fault-tolerance.ts # Retry + error handling
│   │   ├── interrupts.ts     # Human-in-the-loop
│   │   ├── stores.ts         # Shared state stores
│   │   └── subgraphs/        # Subgraphs
│   │       ├── analysts.ts   # Analysts subgraph
│   │       ├── debate.ts     # Bull/Bear debate
│   │       └── risk.ts       # Risk debate
│   ├── checkpoint/           # Persistence
│   │   ├── manager.ts        # SQLite checkpoint
│   │   └── time-travel.ts    # Time-travel utilities
│   ├── memory/               # Decision logs
│   ├── agents/               # Analysts, Researchers, Managers
│   ├── tools/                # Direct tools (DynamicTool)
│   │   ├── dnse/             # Shared DNSE server
│   │   ├── market-data/      # 10 DNSE tools
│   │   ├── trading/          # Placeholder
│   │   ├── account/          # Placeholder
│   │   └── web/              # Tavily, Firecrawl
│   ├── llm/                  # Multi-provider LLM
│   └── prompts.ts            # System prompts
├── mcp-standalone/           # MCP server (dùng riêng)
└── docker-compose.yaml       # Firecrawl services
```

## Cài đặt

```bash
# Cài dependencies
bun install

# Cấu hình
cp .env.example .env

# Chạy
bun run start
```

## Sử dụng

```bash
# Phân tích mã cổ phiếu
> analyze HPG

# Switch model
> switch GPT-4o-mini

# Xem models
> models

# Thoát
> exit
```

## Tech Stack

- **Runtime:** Bun
- **Orchestration:** LangGraph.js (Subgraphs, Interrupts, Conditional Edges)
- **Checkpointing:** In-memory checkpoints for interrupts/resume during the current process
- **LLM:** Multi-provider (NVIDIA, OpenAI, Anthropic, Google, Ollama, DeepSeek)
- **Tools:** Direct DynamicTool (10 DNSE + Web search)
- **Language:** TypeScript

## Tính năng

| Tính năng | Mô tả |
|-----------|-------|
| **Subgraphs** | Tách graph thành analysts, debate, risk subgraphs |
| **Persistence** | Lưu state SQLite, resume khi crash |
| **Time-travel** | Quay lại trạng thái bất kỳ |
| **Interrupts** | Dừng graph để user confirm |
| **Fault tolerance** | Retry + error handling tự động |
| **Stores** | Shared state cho multi-session |
| **Multi-LLM** | Switch giữa 6 providers |

## Hướng phát triển

### Phase 1: Hoàn thiện (Ưu tiên cao)
- [ ] Hoàn thiện `trading/` tools (place_order, cancel_order)
- [ ] Hoàn thiện `account/` tools (get_balance, get_positions)
- [ ] Web UI để visualize graph state
- [ ] API endpoint cho interrupt handling

### Phase 2: Nâng cấp (Ưu tiên trung bình)
- [ ] Streaming responses (token-by-token)
- [ ] Parallel analysts (chạy song song thay vì sequential)
- [ ] Caching layer (Redis) cho LLM responses
- [ ] Backtesting module (test trên data lịch sử)

### Phase 3: Production (Ưu tiên thấp)
- [ ] Authentication + Rate limiting
- [ ] Monitoring + Logging (Prometheus, Grafana)
- [ ] CI/CD pipeline
- [ ] Container deployment (Docker + Kubernetes)

### Phase 4: Mở rộng
- [ ] Support thêm exchanges (HOSE, HNX, UPCOM)
- [ ] Crypto trading (BTC, ETH)
- [ ] Portfolio management (quản lý danh mục)
- [ ] Alert system (cảnh báo giá, volume)
