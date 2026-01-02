/**
 * Pure Passthrough Transformer
 *
 * For use with providers that already speak native Anthropic format (like gcli2api).
 * This transformer does ZERO transformation - only handles auth headers.
 *
 * All format conversion should be handled by the downstream service (gcli2api).
 */
class PurePassthroughTransformer {
  constructor(options = {}) {
    this.options = options;
    this.name = "pure-passthrough";
    this.logger = null;
  }

  log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") {
      this.logger[level](`[PURE-PASSTHROUGH] ${message}`);
    }
  }

  /**
   * Auth handler - sets up headers for the downstream request
   * @param {object} body - Request body (passed through unchanged)
   * @param {object} provider - Provider configuration
   * @param {object} context - Request context
   * @returns {object} - Body and config with auth headers
   */
  async auth(body, provider, context) {
    const headers = {
      "content-type": "application/json",
    };

    // Set auth header based on provider apiKey
    if (provider.apiKey) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
    }

    // Pass through request ID for log correlation
    if (context && context.reqId) {
      headers["X-Request-ID"] = context.reqId;
    }

    // Remove any stale headers
    delete headers["x-api-key"];

    this.log(
      "info",
      `Request ${context?.reqId || "unknown"} -> ${provider.name}`,
    );

    return {
      body,
      config: { headers },
    };
  }

  // All transformation methods are pure passthrough
  async transformRequestIn(body) {
    return { body };
  }

  async transformRequestOut(body) {
    return body;
  }

  async transformResponseIn(response) {
    return response;
  }

  async transformResponseOut(response) {
    return response;
  }
}

module.exports = PurePassthroughTransformer;
