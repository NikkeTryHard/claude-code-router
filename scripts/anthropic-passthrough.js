/**
 * Anthropic Passthrough Transformer
 * For use with providers that already speak native Anthropic format (like gcli2api).
 * 
 * This transformer:
 * 1. Restores the system field from role:system messages
 * 2. Conditionally handles thinking blocks:
 *    - If thinking is ENABLED: preserve native thinking blocks
 *    - If thinking is DISABLED: convert to XML for backward compatibility
 * 3. Passes responses through completely unchanged
 */
class AnthropicPassthroughTransformer {
  constructor(options = {}) {
    this.options = options;
    this.name = 'anthropic-passthrough';
    // Note: We intentionally do NOT set endPoint to avoid conflicts with the built-in Anthropic transformer
    this.logger = null;
  }

  log(level, message) {
    // Always log to console for visibility during debugging
    console.error(`[ANTHROPIC-PASSTHROUGH] ${message}`);
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](message);
    }
  }


  /**
   * Auth handler - sets up Bearer auth header and passes request ID for log correlation
   */
  async auth(body, provider, context) {
    const headers = {
      'authorization': `Bearer ${provider.apiKey}`,
      'x-api-key': undefined,
      'content-type': 'application/json'
    };

    // Pass CCR's request ID to gcli2api for cross-application log correlation
    if (context && context.reqId) {
      headers['X-Request-ID'] = context.reqId;
    }

    return {
      body,
      config: { headers }
    };
  }


  /**
   * Transform incoming request - restore system field and handle thinking blocks
   */
  async transformRequestIn(body, provider, context) {
    const ts = new Date().toISOString();
    this.log('info', `[${ts}] [Anthropic-Passthrough] transformRequestIn called`);

    if (!body || !body.messages) {
      return { body };
    }

    // CRITICAL FIX: Restore system field from role:system messages
    // CCR's router converts the Anthropic 'system' field to OpenAI-style role:system messages
    // gcli2api expects native Anthropic format with separate 'system' field
    const systemMessages = [];
    const nonSystemMessages = [];

    for (const msg of body.messages) {
      if (msg.role === 'system') {
        // Collect system message content
        if (Array.isArray(msg.content)) {
          systemMessages.push(...msg.content);
        } else if (typeof msg.content === 'string') {
          systemMessages.push({ type: 'text', text: msg.content });
        }
      } else {
        nonSystemMessages.push(msg);
      }
    }

    // If we found system messages, restore the system field
    if (systemMessages.length > 0) {
      this.log('info', `[${ts}] [Anthropic-Passthrough] Restoring ${systemMessages.length} system blocks to system field`);
      body.system = systemMessages;
      body.messages = nonSystemMessages;
    }

    // Check if thinking is enabled in the request
    const thinkingEnabled = body.thinking && body.thinking.type === 'enabled';

    // DEBUG: Log thinking state
    this.log('info', `[${ts}] [Anthropic-Passthrough] body.thinking = ${JSON.stringify(body.thinking)}`);
    this.log('info', `[${ts}] [Anthropic-Passthrough] thinkingEnabled = ${thinkingEnabled}`);

    // Count thinking blocks in all messages for debugging
    let totalThinkingBlocks = 0;
    let assistantMsgsWithThinking = 0;
    for (const msg of body.messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const thinkingCount = msg.content.filter(b => b.type === 'thinking').length;
        if (thinkingCount > 0) {
          totalThinkingBlocks += thinkingCount;
          assistantMsgsWithThinking++;
        }
      }
    }
    this.log('info', `[${ts}] [Anthropic-Passthrough] Found ${totalThinkingBlocks} thinking blocks in ${assistantMsgsWithThinking} assistant messages`);

    if (thinkingEnabled) {
      // Thinking is ENABLED: preserve native thinking blocks as-is
      // The Anthropic API expects actual 'thinking' type content blocks
      this.log('info', `[${ts}] [Anthropic-Passthrough] Thinking enabled - preserving ${totalThinkingBlocks} native thinking blocks`);
    } else {
      // Thinking is DISABLED: Convert thinking blocks to XML <thinking> tags
      // This preserves the thinking content while making it API-compatible
      // The Anthropic API rejects native thinking blocks when thinking is disabled,
      // but accepts thinking content wrapped in XML tags as regular text
      if (totalThinkingBlocks > 0) {
        this.log('info', `[${ts}] [Anthropic-Passthrough] Thinking DISABLED - converting ${totalThinkingBlocks} thinking blocks to XML`);
      }

      body.messages = body.messages.map((msg, idx) => {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          let newContent = [];
          let thinkingText = '';
          let standardText = '';
          let modificationNeeded = false;

          msg.content.forEach(block => {
            if (block.type === 'thinking') {
              modificationNeeded = true;
              thinkingText += (block.thinking || '');
            } else if (block.type === 'text') {
              standardText += (block.text || '');
            } else {
              // Keep other blocks (like tool_use, tool_result) intact
              newContent.push(block);
            }
          });

          if (modificationNeeded) {
            this.log('info', `[${ts}] [Anthropic-Passthrough] Msg #${idx}: Converting thinking to XML (thinking len: ${thinkingText.length}, text len: ${standardText.length})`);

            // Wrap thinking in XML tags
            const xmlThought = `<thinking>\n${thinkingText}\n</thinking>`;

            // Combine: XML thinking + existing text content
            const combinedText = standardText
              ? `${xmlThought}\n\n${standardText}`
              : xmlThought;

            // Add combined text block to the front of newContent
            newContent.unshift({ type: 'text', text: combinedText });
            msg.content = newContent;

            this.log('info', `[${ts}] [Anthropic-Passthrough] Msg #${idx}: Converted! New content has ${msg.content.length} blocks`);
          }
        }
        return msg;
      });

      // Double-check: verify no thinking blocks remain
      let remainingThinking = 0;
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          remainingThinking += msg.content.filter(b => b.type === 'thinking').length;
        }
      }
      if (remainingThinking > 0) {
        this.log('error', `[${ts}] [Anthropic-Passthrough] WARNING: ${remainingThinking} thinking blocks still remain after conversion!`);
      } else if (totalThinkingBlocks > 0) {
        this.log('info', `[${ts}] [Anthropic-Passthrough] Successfully converted all thinking blocks to XML`);
      }
    }

    return { body };
  }


  /**
   * Transform outgoing request - pass through unchanged (already Anthropic format)
   */
  async transformRequestOut(body) {
    // Don't transform - body is already in Anthropic format for Anthropic-native endpoints
    return body;
  }

  /**
   * Transform incoming response - pass through unchanged (already Anthropic format)
   * This is the KEY difference from the standard Anthropic transformer!
   */
  async transformResponseIn(response, context) {
    // PASSTHROUGH: gcli2api already returns Anthropic format
    // Do NOT convert from OpenAI to Anthropic
    this.log('info', `[Anthropic-Passthrough] Response passthrough (no conversion)`);
    return response;
  }

  /**
   * Transform outgoing response - pass through unchanged
   */
  async transformResponseOut(response, context) {
    return response;
  }
}

module.exports = AnthropicPassthroughTransformer;
