import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import type { DataSnapshot, TraderOutput, RiskDebateState } from "../types/index";
import { runResearchManager } from "../agents/managers/research-manager";
import { runTrader } from "../agents/trader/trader";
import { LongTermMemoryManager } from "../memory/long-term";
import { graphLogger, logAnalysisStart, logAnalysisStep, logNodeResult } from "../utils/logger";
import { DnseServer, API_BASE_URL } from "../tools/dnse/server";
import { TradingStateAnnotation, type TradingState } from "./state";
import { createAnalystsSubgraph } from "./subgraphs/analysts";
import { createDebateSubgraph } from "./subgraphs/debate";
import { createRiskSubgraph } from "./subgraphs/risk";
import { INTERRUPT_NODES, displayInterruptSummary, askUserConfirm } from "./interrupts";
import * as readline from "readline";

// ==================== BUILD DATA SNAPSHOT ====================

async function buildDataSnapshot(ticker: string, date: string): Promise<DataSnapshot> {
  const server = new DnseServer(
    process.env.DNSE_API_KEY || "",
    process.env.DNSE_API_SECRET || ""
  );

  const safeGet = async (path: string, url: string): Promise<unknown> => {
    try {
      const raw = await server.getJson(path, url);
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[buildDataSnapshot] API failed for ${path}: ${err}`);
      return {};
    }
  };

  const toDate = new Date(date);
  const fromDate = new Date(date);
  fromDate.setDate(fromDate.getDate() - 90);
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  const [closePriceRaw, ohlcRaw, latestTradesRaw, latestQuotesRaw, foreignRaw, secDefRaw, instrumentsRaw] =
    await Promise.all([
      safeGet(`/price/${ticker}/close`, `${API_BASE_URL}/price/${ticker}/close`),
      safeGet("/price/ohlc", `${API_BASE_URL}/price/ohlc?symbol=${ticker}&type=STOCK&resolution=1D&from=${fromTs}&to=${toTs}`),
      safeGet(`/price/${ticker}/trades/latest`, `${API_BASE_URL}/price/${ticker}/trades/latest?boardId=G1`),
      safeGet(`/price/${ticker}/quotes/latest`, `${API_BASE_URL}/price/${ticker}/quotes/latest`),
      safeGet(`/price/${ticker}/foreign-trading`, `${API_BASE_URL}/price/${ticker}/foreign-trading?from=${fromTs}&to=${toTs}`),
      safeGet(`/price/${ticker}/secdef`, `${API_BASE_URL}/price/${ticker}/secdef`),
      safeGet("/instruments", `${API_BASE_URL}/instruments?symbol=${ticker}&limit=1`),
    ]);

  // Parse close price — {prices: [{closePrice, boardId}]}
  const pricesArr = Array.isArray((closePriceRaw as any)?.prices)
    ? ((closePriceRaw as any).prices as Array<Record<string, unknown>>)
    : [];
  const mainPrice =
    pricesArr.find((p) => p.boardId === "G1" && (p.closePrice as number) > 0) ||
    pricesArr.find((p) => (p.closePrice as number) > 0);
  const closePrice = (mainPrice?.closePrice as number) || 0;

  // Parse OHLC — {t:[], o:[], h:[], l:[], c:[], v:[]}
  const ohlcData = ohlcRaw as Record<string, unknown>;
  let ohlcHistory: unknown[] = [];
  if (Array.isArray(ohlcData?.t) && (ohlcData.t as unknown[]).length > 0) {
    const t = ohlcData.t as number[];
    const o = ohlcData.o as number[];
    const h = ohlcData.h as number[];
    const l = ohlcData.l as number[];
    const c = ohlcData.c as number[];
    const v = ohlcData.v as number[];
    ohlcHistory = t.map((ts, i) => ({ t: ts, o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] }));
  } else if (Array.isArray((ohlcData as any)?.data)) {
    ohlcHistory = (ohlcData as any).data as unknown[];
  }

  // Parse latest trades
  const latestTradesData = latestTradesRaw as Record<string, unknown>;
  const latestTrades: unknown[] = Array.isArray(latestTradesData?.data)
    ? (latestTradesData.data as unknown[])
    : Array.isArray(latestTradesRaw) ? (latestTradesRaw as unknown[]) : [];

  return {
    ticker, date, closePrice, ohlcHistory, latestTrades,
    latestQuotes: latestQuotesRaw,
    foreignTrading: foreignRaw,
    secDef: secDefRaw,
    instruments: instrumentsRaw,
    marketNews: "", socialSentiment: "",
    marketReport: "", sentimentReport: "", newsReport: "", fundamentalsReport: "",
  };
}

export { buildDataSnapshot };

// ==================== EMPTY STATES ====================

export const emptyDebateState = {
  history: "", bullHistory: "", bearHistory: "",
  currentResponse: "", judgeDecision: "", count: 0,
};

export const emptyRiskState: RiskDebateState = {
  history: "", aggressiveHistory: "", conservativeHistory: "", neutralHistory: "",
  latestSpeaker: null, currentAggressiveResponse: "",
  currentConservativeResponse: "", currentNeutralResponse: "", count: 0,
};

// ==================== NODES ====================

function createNodes(llm: ChatOpenAI, deepLlm: ChatOpenAI) {
  const memory = new LongTermMemoryManager();

  // ---- fetch ----
  async function fetchData(s: TradingState): Promise<Partial<TradingState>> {
    if (s.dataSnapshot && (s.dataSnapshot.closePrice > 0 || s.dataSnapshot.ohlcHistory.length > 0)) {
      return {};
    }
    const ticker = s.ticker || "";
    const date = s.date || new Date().toISOString().split("T")[0]!;
    if (!ticker) {
      return {
        ticker, date,
        dataSnapshot: {
          ticker, date, closePrice: 0, ohlcHistory: [], latestTrades: [],
          latestQuotes: {}, foreignTrading: {}, secDef: {}, instruments: {},
          marketNews: "", socialSentiment: "",
          marketReport: "", sentimentReport: "", newsReport: "", fundamentalsReport: "",
        },
      };
    }
    graphLogger.nodeStart("Fetch Data", ticker);
    const dataSnapshot = await buildDataSnapshot(ticker, date);
    graphLogger.nodeDone("Fetch Data", 0);
    return { ticker, date, dataSnapshot };
  }

  // ---- load experience ----
  async function loadExperience(s: TradingState): Promise<Partial<TradingState>> {
    if (!s.ticker) return {};
    try {
      const exps = await memory.searchMemories(s.ticker);
      // Inject past experience vào dataSnapshot.marketNews để analysts có thể tham khảo
      if (exps.length > 0 && s.dataSnapshot) {
        const pastSummary = exps
          .map((e: any) => `[${e.date}] ${e.outcome}`)
          .slice(0, 3)
          .join("\n");
        return {
          dataSnapshot: {
            ...s.dataSnapshot,
            marketNews: `KINH NGHIỆM QUÁ KHỨ:\n${pastSummary}\n\n${s.dataSnapshot.marketNews}`,
          },
        };
      }
    } catch (err) {
      console.warn(`[loadExperience] ${err}`);
    }
    return {};
  }

  // ---- research manager ----
  async function researchManager(s: TradingState): Promise<Partial<TradingState>> {
    const start = Date.now();
    graphLogger.nodeStart("Research Manager");
    try {
      // Tách bull/bear từ debate history
      const lines = (s.investmentDebateState?.history || "").split("\n");
      const bullLines = lines.filter((l) => l.startsWith("Bull Researcher:")).join("\n");
      const bearLines = lines.filter((l) => l.startsWith("Bear Researcher:")).join("\n");

      const r = await runResearchManager(
        deepLlm,
        { summary: bullLines || s.investmentDebateState?.bullHistory || "" } as any,
        { summary: bearLines || s.investmentDebateState?.bearHistory || "" } as any,
        lines,
        s.dataSnapshot!
      );
      const plan = `Rating: ${r.decision} | Confidence: ${r.confidence} | ${r.reasoning}`;
      logNodeResult("Research Manager", plan);
      graphLogger.nodeDone("Research Manager", Date.now() - start);
      return { investmentPlan: plan };
    } catch (err) {
      console.error(`[researchManager] ${err}`);
      return { investmentPlan: `Lỗi: ${err}` };
    }
  }

  // ---- trader ----
  async function trader(s: TradingState): Promise<Partial<TradingState>> {
    const start = Date.now();
    graphLogger.nodeStart("Trader");
    try {
      const r = await runTrader(llm, {
        action: "hold", ticker: s.ticker, confidence: 0.5,
        targetPrice: 0, stopLoss: 0, positionSize: "", timeframe: "",
        reasoning: s.investmentPlan || "",
      } as any, s.dataSnapshot!);
      const plan = JSON.stringify(r); // lưu full JSON để risk subgraph parse được
      logNodeResult("Trader", `${r.action} ${r.ticker} | Target: ${r.targetPrice} | SL: ${r.stopLoss}`);
      graphLogger.nodeDone("Trader", Date.now() - start);
      return { traderInvestmentPlan: plan };
    } catch (err) {
      console.error(`[trader] ${err}`);
      const fallback: TraderOutput = {
        action: "hold", ticker: s.ticker, confidence: 0,
        targetPrice: 0, stopLoss: 0, positionSize: "N/A",
        timeframe: "N/A", reasoning: `Lỗi: ${err}`,
      };
      return { traderInvestmentPlan: JSON.stringify(fallback) };
    }
  }

  // ---- save experience ----
  async function saveExperience(s: TradingState): Promise<Partial<TradingState>> {
    if (!s.ticker || !s.finalTradeDecision) return {};
    try {
      await memory.saveEpisodicMemory(`${s.ticker}-${s.date}`, {
        ticker: s.ticker,
        date: s.date,
        event: "Analysis",
        outcome: s.finalTradeDecision,
        lesson: "",
      });
    } catch (err) {
      console.warn(`[saveExperience] ${err}`);
    }
    return {};
  }

  return { fetchData, loadExperience, researchManager, trader, saveExperience };
}

// ==================== BUILD GRAPH ====================

export function buildTradingGraph(
  llm: ChatOpenAI,
  deepLlm: ChatOpenAI,
  checkpointer?: MemorySaver
) {
  const n = createNodes(llm, deepLlm);

  // Khởi tạo 3 subgraphs
  const analystsSubgraph = createAnalystsSubgraph(llm);
  const debateSubgraph = createDebateSubgraph(llm, 2);
  const riskSubgraph = createRiskSubgraph(llm, deepLlm, 1);

  const graph = new StateGraph(TradingStateAnnotation)
    // Nodes
    .addNode("fetch", n.fetchData)
    .addNode("load", n.loadExperience)
    .addNode("analysts", analystsSubgraph)   // subgraph: 4 analysts song song
    .addNode("debate", debateSubgraph)        // subgraph: bull/bear debate loop
    .addNode("manager", n.researchManager)   // ← interrupt point 1
    .addNode("trader", n.trader)
    .addNode("risk", riskSubgraph)            // ← interrupt point 2: subgraph: aggressive/conservative/neutral → portfolio
    .addNode("save", n.saveExperience)
    // Edges
    .addEdge(START, "fetch")
    .addEdge("fetch", "load")
    .addEdge("load", "analysts")
    .addEdge("analysts", "debate")
    .addEdge("debate", "manager")
    .addEdge("manager", "trader")
    .addEdge("trader", "risk")
    .addEdge("risk", "save")
    .addEdge("save", END);

  return graph.compile({
    checkpointer,
    // Dừng TRƯỚC "manager" (sau debate) và TRƯỚC "risk" (sau trader)
    // để user xem trung gian và quyết định tiếp tục hay huỷ
    interruptBefore: [...INTERRUPT_NODES],
  });
}

// ==================== ANALYZE ====================

export async function analyze(
  llm: ChatOpenAI,
  ticker: string,
  date: string,
  options: {
    checkpointer?: MemorySaver;
    rl?: readline.Interface;
    /** Tắt interrupt (dùng khi gọi từ LangGraph Studio hoặc test) */
    noInterrupt?: boolean;
  } = {}
): Promise<string> {
  logAnalysisStart(ticker);

  const deepLlm = new ChatOpenAI({
    model: process.env.DEEP_MODEL || "nvidia/deepseek-ai/deepseek-v4-pro",
    apiKey: process.env.LLM_API_KEY,
    temperature: 0.3,
    configuration: { baseURL: process.env.LLM_BASE_URL || "http://localhost:20128/v1" },
  });

  // Mỗi lần analyze là 1 thread riêng — dùng ticker+date làm thread_id
  // để checkpointer lưu state và có thể resume sau interrupt
  const threadId = `${ticker.toLowerCase()}-${date}`;
  const config = { configurable: { thread_id: threadId } };

  // Nếu có checkpointer → dùng interrupt; không có → chạy thẳng
  const useInterrupt = !options.noInterrupt && !!options.checkpointer;
  const graph = buildTradingGraph(llm, deepLlm, useInterrupt ? options.checkpointer : undefined);

  logAnalysisStep(1, 6, "Fetch & Load Experience");
  logAnalysisStep(2, 6, "4 Analysts (Market, Sentiment, News, Fundamentals) — song song");
  logAnalysisStep(3, 6, "Bull/Bear Debate (2 rounds)");
  logAnalysisStep(4, 6, "Research Manager → Trader");
  logAnalysisStep(5, 6, "Risk Team (Aggressive, Conservative, Neutral)");
  logAnalysisStep(6, 6, "Portfolio Manager → Save");
  console.log("");

  const initialInput = {
    ticker,
    date,
    dataSnapshot: await buildDataSnapshot(ticker, date),
    marketReport: "",
    sentimentReport: "",
    newsReport: "",
    fundamentalsReport: "",
    investmentDebateState: emptyDebateState,
    investmentPlan: "",
    traderInvestmentPlan: "",
    riskDebateState: emptyRiskState,
    finalTradeDecision: "",
    error: null,
    retryCount: 0,
    messages: [],
  };

  // Không có interrupt → invoke thẳng, nhanh hơn
  if (!useInterrupt) {
    const result = await graph.invoke(initialInput, config);
    return result.finalTradeDecision || "Không có kết quả";
  }

  // ---- Chạy với interrupt ----
  // Vòng lặp: stream → gặp interrupt → user confirm → stream(null) resume
  // Input chỉ truyền lần đầu; các lần resume truyền null để tiếp tục từ checkpoint
  let currentInput: typeof initialInput | null = initialInput;
  let finalDecision = "";

  while (true) {
    // Stream từ checkpoint (hoặc từ đầu nếu lần đầu)
    const stream = await graph.stream(currentInput, {
      ...config,
      streamMode: "values",
    });

    let lastState: Partial<TradingState> = {};

    for await (const chunk of stream) {
      lastState = chunk as Partial<TradingState>;
    }

    // Kiểm tra graph đã chạy xong chưa hay đang bị interrupt
    const graphState = await graph.getState(config);
    const nextNodes = graphState.next as string[];

    if (!nextNodes || nextNodes.length === 0) {
      // Graph đã xong
      finalDecision = (lastState as TradingState).finalTradeDecision || "Không có kết quả";
      break;
    }

    // Graph đang dừng tại interrupt — nextNodes[0] là node sắp chạy
    const pausedAt = nextNodes[0] as "manager" | "risk";
    displayInterruptSummary(pausedAt, lastState as Partial<TradingState>);

    if (options.rl) {
      const confirmed = await askUserConfirm(pausedAt, options.rl);
      if (!confirmed) {
        finalDecision = "Phân tích đã bị huỷ bởi người dùng.";
        break;
      }
    } else {
      // Không có readline (headless/test) → tự động tiếp tục
      console.log(`[INTERRUPT] Auto-continue tại ${pausedAt} (không có readline)\n`);
    }

    // Resume: truyền null để graph tiếp tục từ checkpoint
    currentInput = null;
  }

  return finalDecision;
}
