import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { analyze } from "./graph/trading-graph";
import { SYSTEM_PROMPT } from "./prompts";
import { LLMManager, getAllModels, getModelsByProvider, type LLMProvider } from "./llm/index";
import { createAllTools } from "./tools/index";
import { PaperPortfolioTracker } from "./portfolio/tracker";
import { createBot, setupErrorHandler, createWhitelistMiddleware } from "./telegram/bot";
import { setupHandlers } from "./telegram/handlers";
import { startCronJobs } from "./scheduler/cron";
import { MemorySaver } from "@langchain/langgraph";
import * as readline from "readline";

// ==================== CONFIG ====================

const llmManager = new LLMManager({
  quickModel: process.env.QUICK_MODEL || "Nemotron 70B",
  deepModel: process.env.DEEP_MODEL || "Nemotron 70B",
  quickApiKey: process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY,
  deepApiKey: process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY,
});

const portfolioTracker = new PaperPortfolioTracker();

// Checkpointer dùng chung trong thời gian tiến trình đang chạy.
let checkpointer: MemorySaver | null = null;

async function getCheckpointer(): Promise<MemorySaver> {
  if (!checkpointer) {
    checkpointer = new MemorySaver();
    console.log("[Checkpoint] Dùng bộ nhớ trong; checkpoints sẽ mất khi tiến trình thoát");
  }
  return checkpointer;
}

// ==================== TELEGRAM BOT ====================

async function startTelegramBot(llm: ChatOpenAI): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[Telegram] TELEGRAM_BOT_TOKEN không được set — bỏ qua khởi động bot");
    return;
  }

  const allowedIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const bot = createBot(token);
  setupErrorHandler(bot);
  bot.use(createWhitelistMiddleware(allowedIds));
  setupHandlers(bot, llm);

  // Khởi động cron jobs
  startCronJobs(llm, bot, allowedIds);

  // Bắt đầu polling (không block — chạy nền)
  bot.start({
    onStart: (info) => console.log(`[Telegram] Bot @${info.username} đang chạy (polling)`),
    drop_pending_updates: true,
  });

  console.log("[Telegram] Bot đã khởi động");
}

// ==================== MAIN ====================

async function main() {
  console.log("Đang tải tools...");

  const allTools = createAllTools();
  console.log(`Đã tải ${allTools.length} tools: ${allTools.map((t) => t.name).join(", ")}`);

  const currentModels = llmManager.getCurrentModels();
  console.log(`\n[LLM] Quick model: ${currentModels.quick}`);
  console.log(`[LLM] Deep model: ${currentModels.deep}`);

  // Khởi động Telegram bot nếu có token
  const llm = llmManager.getQuickLLM() as ChatOpenAI;
  await startTelegramBot(llm);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n=== DNSE TradingAgents ===");
  console.log("Hệ thống phân tích đầu tư đa agent");
  console.log("");
  console.log("LỆNH:");
  console.log("  analyze <ticker>           - Phân tích mã chứng khoán");
  console.log("  buy <ticker> <qty> <price>  - Ghi nhận mua giả định (paper trading)");
  console.log("  close <positionId> <price> - Đóng vị thế giả định");
  console.log("  portfolio                  - Xem danh sách vị thế");
  console.log("  switch <model>             - Switch quick model");
  console.log("  switch-deep <model>        - Switch deep model");
  console.log("  models                     - Liệt kê models có sẵn");
  console.log("  models-provider <provider> - Liệt kê models theo provider");
  console.log("  current                    - Xem models đang dùng");
  console.log("  exit                       - Thoát");
  console.log("");

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question("You: ", (answer) => {
        resolve(answer);
      });
    });
  };

  while (true) {
    const userInput = await askQuestion();

    if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
      console.log("Tạm biệt!");
      break;
    }

    if (!userInput.trim()) continue;

    const parts = userInput.trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();

    // /buy HPG 1000 26.8
    if (command === "buy" && parts.length >= 4) {
      const ticker = parts[1]?.toUpperCase() ?? "";
      const quantity = parseFloat(parts[2] ?? "0");
      const avgCost = parseFloat(parts[3] ?? "0");

      if (isNaN(quantity) || isNaN(avgCost)) {
        console.log("\n[Lỗi] Số lượng và giá phải là số\n");
        continue;
      }

      const note = parts.slice(4).join(" ") || undefined;
      const result = await portfolioTracker.openPosition({ ticker, quantity, avgCost, note });
      console.log(`\n${result.message}\n`);
      continue;
    }

    // /close <positionId> <price>
    if (command === "close" && parts.length >= 3) {
      const positionId = parts[1] ?? "";
      const closePrice = parseFloat(parts[2] ?? "0");

      if (isNaN(closePrice)) {
        console.log("\n[Lỗi] Giá phải là số\n");
        continue;
      }

      const result = await portfolioTracker.closePosition({ positionId, closePrice });
      console.log(`\n${result.message}\n`);
      continue;
    }

    // /portfolio - xem tất cả vị thế
    if (command === "portfolio") {
      const positions = await portfolioTracker.getAllPositions();
      
      if (positions.length === 0) {
        console.log("\nChưa có vị thế nào.\n");
        continue;
      }

      console.log("\n=== DANH SÁCH VỊ THẾ ===\n");
      for (const pos of positions) {
        const status = pos.status === "open" ? "🟢 MỞ" : "🔴 ĐÓNG";
        const pnl = pos.realizedPnl !== null ? `${pos.realizedPnl.toLocaleString("vi-VN")}đ` : "---";
        
        console.log(`${pos.ticker} | ${pos.quantity} cổ | Giá: ${pos.avgCost.toLocaleString("vi-VN")}đ | ${status} | P&L: ${pnl}`);
        console.log(`  ID: ${pos.id.slice(0, 8)} | Ngày mở: ${pos.openDate}`);
        if (pos.note) console.log(`  Ghi chú: ${pos.note}`);
        console.log("");
      }
      continue;
    }

    if (command === "switch" && parts[1]) {
      const modelName = parts.slice(1).join(" ");
      try {
        llmManager.switchQuickModel(modelName);
        const current = llmManager.getCurrentModels();
        console.log(`\n[OK] Đã chuyển quick model sang: ${current.quick}\n`);
      } catch (error) {
        console.log(`\n[Lỗi] Không thể switch model: ${error}\n`);
      }
      continue;
    }

    if (command === "switch-deep" && parts[1]) {
      const modelName = parts.slice(1).join(" ");
      try {
        llmManager.switchDeepModel(modelName);
        const current = llmManager.getCurrentModels();
        console.log(`\n[OK] Đã chuyển deep model sang: ${current.deep}\n`);
      } catch (error) {
        console.log(`\n[Lỗi] Không thể switch model: ${error}\n`);
      }
      continue;
    }

    if (command === "models") {
      console.log("\n=== DANH SÁCH MODELS ===\n");
      const models = getAllModels();
      console.log("| Tên | Provider | Tier | Mô tả |");
      console.log("|-----|----------|------|-------|");
      for (const model of models) {
        console.log(`| ${model.name} | ${model.provider} | ${model.tier} | ${model.description} |`);
      }
      console.log("");
      continue;
    }

    if (command === "models-provider" && parts[1]) {
      const provider = parts[1] as LLMProvider;
      console.log(`\n=== MODELS CHO ${provider.toUpperCase()} ===\n`);
      const models = getModelsByProvider(provider);
      if (models.length === 0) {
        console.log("Không tìm thấy models cho provider này.");
      } else {
        console.log("| Tên | Model ID | Tier | Mô tả |");
        console.log("|-----|----------|------|-------|");
        for (const model of models) {
          console.log(`| ${model.name} | ${model.model} | ${model.tier} | ${model.description} |`);
        }
      }
      console.log("");
      continue;
    }

    if (command === "current") {
      const current = llmManager.getCurrentModels();
      console.log(`\n[LLM] Quick model: ${current.quick}`);
      console.log(`[LLM] Deep model: ${current.deep}\n`);
      continue;
    }

    const analyzeMatch = userInput.trim().match(/^analyze\s+(\w+)$/i);
    if (analyzeMatch && analyzeMatch[1]) {
      const ticker = analyzeMatch[1].toUpperCase();
      const date = new Date().toISOString().split("T")[0] ?? new Date().toISOString();

      console.log(`\n[Bắt đầu phân tích ${ticker}...]`);
      console.log("[Quy trình: Data → 4 Analysts → Bull/Bear Debate ⏸ Research Manager → Trader ⏸ Risk Team → Portfolio Manager]");
      console.log("[⏸ = điểm dừng để bạn xác nhận trước khi tiếp tục]\n");

      try {
        const llm = llmManager.getQuickLLM();
        const cp = await getCheckpointer();
        const result = await analyze(llm as ChatOpenAI, ticker, date, {
          checkpointer: cp,
          rl,
        });

        console.log("\n" + "=".repeat(60));
        console.log("KẾT QUẢ PHÂN TÍCH");
        console.log("=".repeat(60));
        console.log(result);
        console.log("=".repeat(60));
        console.log("\n⚠️ LƯU Ý: Đây là phân tích tham khảo, không phải lời khuyên tài chính.");
        console.log("   Hãy tham vấn cố vấn tài chính trước khi quyết định.\n");
      } catch (error) {
        console.error(`\nLỗi khi phân tích: ${error}\n`);
      }
    } else {
      const chatLlm = llmManager.getQuickLLM();
      const modelWithTools = (chatLlm as ChatOpenAI).bindTools(allTools);
      const chatHistory: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [];
      chatHistory.push(new SystemMessage(SYSTEM_PROMPT));
      chatHistory.push(new HumanMessage(userInput));

      try {
        const response = await modelWithTools.invoke(chatHistory);

        if (response.tool_calls && response.tool_calls.length > 0) {
          chatHistory.push(response);

          for (const toolCall of response.tool_calls) {
            console.log(`\n[Gọi tool: ${toolCall.name}]`);

            const tool = allTools.find((t) => t.name === toolCall.name);
            if (tool) {
              const args = typeof toolCall.args === "string"
                ? JSON.parse(toolCall.args)
                : toolCall.args;
              const toolResult = await (tool as DynamicTool).invoke(args);
              const resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
              console.log(`[Kết quả: ${resultStr.substring(0, 200)}...]`);
              chatHistory.push(
                new ToolMessage({
                  content: resultStr,
                  tool_call_id: toolCall.id!,
                })
              );
            }
          }

          const finalResponse = await modelWithTools.invoke(chatHistory);
          const aiMessage =
            typeof finalResponse.content === "string"
              ? finalResponse.content
              : JSON.stringify(finalResponse.content);
          console.log(`\nTrợ lý: ${aiMessage}\n`);
        } else {
          const aiMessage =
            typeof response.content === "string"
              ? response.content
              : JSON.stringify(response.content);
          console.log(`\nTrợ lý: ${aiMessage}\n`);
        }
      } catch (error) {
        console.error(`\nLỗi: ${error}\n`);
      }
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error("Lỗi nghiêm trọng:", error);
  process.exit(1);
});
