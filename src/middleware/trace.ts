import { FastifyRequest, FastifyReply } from "fastify";

export interface TraceLogData {
  level: "trace";
  reqId: string;
  stage:
    | "incoming"
    | "router"
    | "transformer"
    | "provider"
    | "response"
    | "error"
    | "agent-tool";
  timestamp: string;
  body?: any;
  metadata?: Record<string, any>;
  error?: any;
}

/**
 * Create a trace log entry
 */
export function createTraceLog(
  reqId: string,
  stage: TraceLogData["stage"],
  data: {
    body?: any;
    metadata?: Record<string, any>;
    error?: any;
  },
): TraceLogData {
  return {
    level: "trace",
    reqId,
    stage,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

/**
 * Log trace data if trace mode is enabled
 */
export function logTrace(
  logger: any,
  config: any,
  reqId: string,
  stage: TraceLogData["stage"],
  data: {
    body?: any;
    metadata?: Record<string, any>;
    error?: any;
  },
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const traceLog = createTraceLog(reqId, stage, data);

  // Include body only if TRACE_INCLUDE_BODIES is enabled
  if (!config.TRACE_INCLUDE_BODIES && traceLog.body) {
    traceLog.body =
      "[BODY OMITTED - Enable TRACE_INCLUDE_BODIES to see full body]";
  }

  // Log with TRACE prefix for easy filtering
  logger.info({ TRACE: traceLog }, `[TRACE] ${stage.toUpperCase()}`);
}

/**
 * Middleware to log incoming requests
 */
export function traceIncomingRequest(req: FastifyRequest, config: any): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || req.headers["x-request-id"] || "unknown";

  logTrace(req.log, config, reqId, "incoming", {
    body: (req as any).body,
    metadata: {
      url: req.url,
      method: req.method,
      headers: req.headers,
      sessionId: (req as any).sessionId,
    },
  });
}

/**
 * Log router decision
 */
export function traceRouterDecision(
  req: FastifyRequest,
  config: any,
  decision: {
    selectedModel: string;
    tokenCount?: number;
    reason?: string;
  },
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "router", {
    metadata: decision,
  });
}

/**
 * Log transformer output
 */
export function traceTransformerOutput(
  req: FastifyRequest,
  config: any,
  transformedBody: any,
  provider: string,
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "transformer", {
    body: transformedBody,
    metadata: {
      provider,
    },
  });
}

/**
 * Log provider response
 */
export function traceProviderResponse(
  req: FastifyRequest,
  config: any,
  response: any,
  provider: string,
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "provider", {
    body: response,
    metadata: {
      provider,
    },
  });
}

/**
 * Log final response
 */
export function traceFinalResponse(
  req: FastifyRequest,
  config: any,
  response: any,
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "response", {
    body: response,
  });
}

/**
 * Log error
 */
export function traceError(req: FastifyRequest, config: any, error: any): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "error", {
    error: {
      message: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
      response: error.response,
    },
  });
}

/**
 * Log agent tool execution
 */
export function traceAgentTool(
  req: FastifyRequest,
  config: any,
  toolData: {
    toolName: string;
    toolArgs: any;
    toolResult: any;
  },
): void {
  if (!config.TRACE_MODE) {
    return;
  }

  const reqId = (req as any).id || "unknown";

  logTrace(req.log, config, reqId, "agent-tool", {
    metadata: toolData,
  });
}
