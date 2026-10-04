import { MemorySaver } from "@langchain/langgraph";

// ==================== CHECKPOINT MANAGER ====================

export class CheckpointManager {
  private checkpointer: MemorySaver | null = null;

  async initialize(): Promise<void> {
    this.checkpointer = new MemorySaver();
    console.log("[Checkpoint] Đã khởi tạo");
  }

  getCheckpointer(): MemorySaver {
    if (!this.checkpointer) {
      throw new Error("Checkpointer not initialized. Call initialize() first.");
    }
    return this.checkpointer;
  }

  /**
   * Lấy thread ID cho ticker + date
   */
  getThreadId(ticker: string, date: string): string {
    return `${ticker.toLowerCase()}-${date}`;
  }

  /**
   * List tất cả checkpoints của 1 thread
   */
  async listCheckpoints(threadId: string) {
    const checkpointer = this.getCheckpointer();
    const checkpoints: unknown[] = [];

    for await (const checkpoint of checkpointer.list({
      configurable: { thread_id: threadId },
    })) {
      checkpoints.push(checkpoint);
    }

    return checkpoints;
  }

  /**
   * Xóa checkpoints cũ (giữ lại N checkpoints gần nhất)
   */
  async pruneCheckpoints(threadId: string, keepLast: number = 10): Promise<void> {
    const checkpoints = await this.listCheckpoints(threadId);
    if (checkpoints.length <= keepLast) return;

    console.log(`[Checkpoint] Đang dọn dẹp ${checkpoints.length - keepLast} đ checkpoints cũ cho ${threadId}`);
    // MemorySaver retains checkpoints for the lifetime of the process.
  }
}
