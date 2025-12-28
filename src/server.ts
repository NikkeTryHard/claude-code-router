import Server from "@musistudio/llms";
import { readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
import { checkForUpdates, performUpdate } from "./utils";
import { join } from "path";
import path from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import {calculateTokenCount} from "./utils/router";

/**
 * Load custom transformers from config.
 * This function handles absolute paths correctly and provides detailed error logging.
 */
async function loadCustomTransformers(server: Server, config: any): Promise<void> {
  const transformers = config.transformers || [];
  const log = server.app.log;

  if (transformers.length === 0) {
    return;
  }

  log.info(`[CCR] Loading ${transformers.length} custom transformer(s)...`);

  for (const transformerConfig of transformers) {
    const { name, path: transformerPath, options = {} } = transformerConfig;

    if (!transformerPath) {
      log.error(`[CCR] Transformer "${name}" has no path specified, skipping.`);
      continue;
    }

    try {
      // Resolve the path - handle both absolute and relative paths
      let resolvedPath: string;
      if (path.isAbsolute(transformerPath)) {
        resolvedPath = transformerPath;
      } else {
        // Relative to config directory
        resolvedPath = join(homedir(), ".claude-code-router", transformerPath);
      }

      // Check if file exists
      if (!existsSync(resolvedPath)) {
        log.error(`[CCR] Transformer file not found: ${resolvedPath}`);
        continue;
      }

      // Clear require cache to allow hot-reloading
      delete require.cache[require.resolve(resolvedPath)];

      // Load the transformer module
      const TransformerModule = require(resolvedPath);

      // Handle both class exports and default exports
      const TransformerClass = TransformerModule.default || TransformerModule;

      if (typeof TransformerClass !== "function") {
        log.error(`[CCR] Transformer "${name}" at ${resolvedPath} does not export a class/constructor.`);
        continue;
      }

      // Instantiate the transformer
      const instance = new TransformerClass(options);

      // Inject logger if available
      if (instance && typeof instance === "object") {
        instance.logger = log;
      }

      // Validate the instance has a name
      if (!instance.name) {
        log.error(`[CCR] Transformer instance from ${resolvedPath} does not have a 'name' property.`);
        continue;
      }

      // Wait for transformerService to be available
      const waitForService = async (retries = 10): Promise<boolean> => {
        for (let i = 0; i < retries; i++) {
          if (server.app._server?.transformerService) {
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
      };

      const serviceReady = await waitForService();
      if (!serviceReady) {
        log.error(`[CCR] TransformerService not available after waiting, cannot register "${instance.name}".`);
        continue;
      }

      // Register the transformer
      server.app._server!.transformerService.registerTransformer(instance.name, instance);
      log.info(`[CCR] Successfully loaded custom transformer: "${instance.name}" from ${resolvedPath}`);

    } catch (error: any) {
      log.error(`[CCR] Failed to load transformer "${name}" from ${transformerPath}: ${error.message}`);
      if (error.stack) {
        log.error(`[CCR] Stack: ${error.stack}`);
      }
    }
  }
}

export const createServer = (config: any): Server => {
  const server = new Server(config);

  // Load custom transformers after server initialization
  // Use onReady hook to ensure transformerService is available
  server.app.addHook("onReady", async () => {
    const fullConfig = await readConfigFile();
    await loadCustomTransformers(server, fullConfig);
  });

  server.app.post("/v1/messages/count_tokens", async (req, reply) => {
    const {messages, tools, system} = req.body;
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Add endpoint to read config.json with access control
  server.app.get("/api/config", async (req, reply) => {
    return await readConfigFile();
  });

  server.app.get("/api/transformers", async () => {
    const transformers =
      server.app._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  server.app.post("/api/config", async (req, reply) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    return { success: true, message: "Config saved successfully" };
  });

  // Add endpoint to restart the service with access control
  server.app.post("/api/restart", async (req, reply) => {
    reply.send({ success: true, message: "Service restart initiated" });

    // Restart the service after a short delay to allow response to be sent
    setTimeout(() => {
      const { spawn } = require("child_process");
      spawn(process.execPath, [process.argv[1], "restart"], {
        detached: true,
        stdio: "ignore",
      });
    }, 1000);
  });

  // Register static file serving with caching
  server.app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  server.app.get("/ui", async (_, reply) => {
    return reply.redirect("/ui/");
  });

  // 版本检查端点
  server.app.get("/api/update/check", async (req, reply) => {
    try {
      // 获取当前版本
      const currentVersion = require("../package.json").version;
      const { hasUpdate, latestVersion, changelog } = await checkForUpdates(currentVersion);

      return {
        hasUpdate,
        latestVersion: hasUpdate ? latestVersion : undefined,
        changelog: hasUpdate ? changelog : undefined
      };
    } catch (error) {
      console.error("Failed to check for updates:", error);
      reply.status(500).send({ error: "Failed to check for updates" });
    }
  });

  // 执行更新端点
  server.app.post("/api/update/perform", async (req, reply) => {
    try {
      // 只允许完全访问权限的用户执行更新
      const accessLevel = (req as any).accessLevel || "restricted";
      if (accessLevel !== "full") {
        reply.status(403).send("Full access required to perform updates");
        return;
      }

      // 执行更新逻辑
      const result = await performUpdate();

      return result;
    } catch (error) {
      console.error("Failed to perform update:", error);
      reply.status(500).send({ error: "Failed to perform update" });
    }
  });

  // 获取日志文件列表端点
  server.app.get("/api/logs/files", async (req, reply) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // 按修改时间倒序排列
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // 获取日志内容端点
  server.app.get("/api/logs", async (req, reply) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // 清除日志内容端点
  server.app.delete("/api/logs", async (req, reply) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // 如果指定了文件路径，使用指定的路径
        logFilePath = filePath;
      } else {
        // 如果没有指定文件路径，使用默认的日志文件路径
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  return server;
};
