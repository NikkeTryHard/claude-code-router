import { writeFile, readFile, readdir, mkdir, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { HOME_DIR } from "../constants";

const REPLAY_DIR = join(HOME_DIR, "replays");
const MAX_REPLAYS = 50;

export interface ReplayData {
  id: string;
  timestamp: string;
  reqId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  error?: {
    statusCode?: number;
    message: string;
    response?: any;
  };
  response?: any;
  metadata: {
    model?: string;
    provider?: string;
    sessionId?: string;
  };
}

/**
 * Initialize replay directory
 */
export async function initReplayDir(): Promise<void> {
  if (!existsSync(REPLAY_DIR)) {
    await mkdir(REPLAY_DIR, { recursive: true });
  }
}

/**
 * Generate unique replay ID
 */
function generateReplayId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}_${random}`;
}

/**
 * Save a request replay
 */
export async function saveReplay(
  data: Omit<ReplayData, "id" | "timestamp">,
): Promise<string> {
  await initReplayDir();

  const id = generateReplayId();
  const replay: ReplayData = {
    id,
    timestamp: new Date().toISOString(),
    ...data,
  };

  const filePath = join(REPLAY_DIR, `${id}.json`);
  await writeFile(filePath, JSON.stringify(replay, null, 2), "utf-8");

  // Cleanup old replays if we exceed MAX_REPLAYS
  await cleanupOldReplays();

  return id;
}

/**
 * Get a specific replay by ID
 */
export async function getReplay(id: string): Promise<ReplayData | null> {
  const filePath = join(REPLAY_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    return null;
  }

  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content);
}

/**
 * List all replays, sorted by timestamp (newest first)
 */
export async function listReplays(): Promise<ReplayData[]> {
  await initReplayDir();

  const files = await readdir(REPLAY_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  const replays: ReplayData[] = [];
  for (const file of jsonFiles) {
    try {
      const content = await readFile(join(REPLAY_DIR, file), "utf-8");
      replays.push(JSON.parse(content));
    } catch (error) {
      console.error(`Failed to read replay file ${file}:`, error);
    }
  }

  // Sort by timestamp, newest first
  replays.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return replays;
}

/**
 * Get the most recent replay
 */
export async function getLatestReplay(): Promise<ReplayData | null> {
  const replays = await listReplays();
  return replays.length > 0 ? replays[0] : null;
}

/**
 * Delete a specific replay
 */
export async function deleteReplay(id: string): Promise<boolean> {
  const filePath = join(REPLAY_DIR, `${id}.json`);

  if (!existsSync(filePath)) {
    return false;
  }

  await unlink(filePath);
  return true;
}

/**
 * Clear all replays
 */
export async function clearAllReplays(): Promise<number> {
  await initReplayDir();

  const files = await readdir(REPLAY_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  for (const file of jsonFiles) {
    await unlink(join(REPLAY_DIR, file));
  }

  return jsonFiles.length;
}

/**
 * Cleanup old replays, keeping only MAX_REPLAYS most recent
 */
async function cleanupOldReplays(): Promise<void> {
  const replays = await listReplays();

  if (replays.length <= MAX_REPLAYS) {
    return;
  }

  // Delete oldest replays
  const toDelete = replays.slice(MAX_REPLAYS);
  for (const replay of toDelete) {
    await deleteReplay(replay.id);
  }
}

/**
 * Get replay statistics
 */
export async function getReplayStats(): Promise<{
  total: number;
  totalSize: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
}> {
  await initReplayDir();

  const files = await readdir(REPLAY_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  let totalSize = 0;
  const timestamps: string[] = [];

  for (const file of jsonFiles) {
    const filePath = join(REPLAY_DIR, file);
    const stats = await stat(filePath);
    totalSize += stats.size;

    try {
      const content = await readFile(filePath, "utf-8");
      const replay = JSON.parse(content);
      timestamps.push(replay.timestamp);
    } catch (error) {
      // Skip invalid files
    }
  }

  timestamps.sort();

  return {
    total: jsonFiles.length,
    totalSize,
    oldestTimestamp: timestamps.length > 0 ? timestamps[0] : null,
    newestTimestamp:
      timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
  };
}
