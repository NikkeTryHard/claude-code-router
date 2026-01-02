import {
  listReplays,
  getReplay,
  getLatestReplay,
  clearAllReplays,
  getReplayStats,
  ReplayData,
} from "./replay";
import { getServiceInfo } from "./processCheck";

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Format timestamp to readable date
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Execute a replay request
 */
async function executeReplay(replay: ReplayData): Promise<void> {
  const serviceInfo = await getServiceInfo();

  console.log(`\n🔄 Replaying request: ${replay.id}`);
  console.log(`   Original timestamp: ${formatTimestamp(replay.timestamp)}`);
  console.log(`   Model: ${replay.metadata.model || "N/A"}`);
  console.log(`   Provider: ${replay.metadata.provider || "N/A"}\n`);

  try {
    const response = await fetch(`${serviceInfo.endpoint}${replay.url}`, {
      method: replay.method,
      headers: {
        ...replay.headers,
        "x-replay-id": replay.id,
        "x-replay-timestamp": replay.timestamp,
      },
      body: JSON.stringify(replay.body),
    });

    console.log(
      `✅ Response status: ${response.status} ${response.statusText}\n`,
    );

    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      console.log("📡 Streaming response:\n");
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          process.stdout.write(chunk);
        }
      }
    } else {
      const data = await response.json();
      console.log("📦 Response body:");
      console.log(JSON.stringify(data, null, 2));
    }

    console.log("\n✅ Replay completed successfully");
  } catch (error: any) {
    console.error(`\n❌ Replay failed: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Handle replay command
 */
export async function handleReplayCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
    case "ls":
      const replays = await listReplays();
      if (replays.length === 0) {
        console.log("No replays found.");
        return;
      }

      console.log(`\n📋 Saved Replays (${replays.length}):\n`);
      for (const replay of replays) {
        const errorInfo = replay.error
          ? ` ❌ ${replay.error.statusCode || "ERROR"}: ${replay.error.message}`
          : " ✅";
        console.log(`  ${replay.id}`);
        console.log(`    Time: ${formatTimestamp(replay.timestamp)}`);
        console.log(`    Model: ${replay.metadata.model || "N/A"}`);
        console.log(`    Provider: ${replay.metadata.provider || "N/A"}`);
        console.log(`    Status:${errorInfo}`);
        console.log();
      }

      const stats = await getReplayStats();
      console.log(`Total size: ${formatBytes(stats.totalSize)}`);
      break;

    case "run":
    case "exec":
      const replayId = args[1];
      if (!replayId) {
        console.error("❌ Error: Please specify a replay ID or 'latest'");
        console.log("\nUsage: ccr replay run <replay-id|latest>");
        process.exit(1);
      }

      let replayToRun: ReplayData | null = null;

      if (replayId === "latest") {
        replayToRun = await getLatestReplay();
        if (!replayToRun) {
          console.error("❌ No replays found");
          process.exit(1);
        }
      } else {
        replayToRun = await getReplay(replayId);
        if (!replayToRun) {
          console.error(`❌ Replay not found: ${replayId}`);
          process.exit(1);
        }
      }

      await executeReplay(replayToRun);
      break;

    case "clear":
    case "clean":
      const count = await clearAllReplays();
      console.log(`✅ Cleared ${count} replay(s)`);
      break;

    case "stats":
      const replayStats = await getReplayStats();
      console.log("\n📊 Replay Statistics:\n");
      console.log(`  Total replays: ${replayStats.total}`);
      console.log(`  Total size: ${formatBytes(replayStats.totalSize)}`);
      if (replayStats.oldestTimestamp) {
        console.log(
          `  Oldest: ${formatTimestamp(replayStats.oldestTimestamp)}`,
        );
      }
      if (replayStats.newestTimestamp) {
        console.log(
          `  Newest: ${formatTimestamp(replayStats.newestTimestamp)}`,
        );
      }
      console.log();
      break;

    case "show":
    case "view":
      const showId = args[1];
      if (!showId) {
        console.error("❌ Error: Please specify a replay ID");
        console.log("\nUsage: ccr replay show <replay-id>");
        process.exit(1);
      }

      const replayToShow = await getReplay(showId);
      if (!replayToShow) {
        console.error(`❌ Replay not found: ${showId}`);
        process.exit(1);
      }

      console.log("\n📄 Replay Details:\n");
      console.log(JSON.stringify(replayToShow, null, 2));
      break;

    default:
      console.log(`
Usage: ccr replay <command> [options]

Commands:
  list, ls              List all saved replays
  run <id|latest>       Re-run a specific replay or the latest one
  show <id>             Show detailed information about a replay
  stats                 Show replay statistics
  clear, clean          Clear all saved replays

Examples:
  ccr replay list
  ccr replay run latest
  ccr replay run 2026-01-02T12-34-56-789Z_abc123
  ccr replay show 2026-01-02T12-34-56-789Z_abc123
  ccr replay stats
  ccr replay clear
`);
      break;
  }
}
