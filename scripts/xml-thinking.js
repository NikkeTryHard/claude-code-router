/**
 * XML Thinking Transformer
 * Converts JSON thinking blocks to XML text format for APIs that don't support thinking blocks.
 */
class XmlThinkingTransformer {
  constructor(options = {}) {
    this.options = options;
    this.name = 'xml-thinking';
    this.logger = null; // Will be injected by the framework
  }

  /**
   * Log helper - uses injected logger or falls back to console
   */
  log(level, message) {
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level](message);
    } else {
      console[level === 'info' ? 'log' : level](message);
    }
  }

  /**
   * Transform incoming request - convert thinking blocks in assistant messages to XML
   */
  async transformRequestIn(body, provider, context) {
    const ts = new Date().toISOString();
    this.log('info', `[${ts}] [XML-Transformer] transformRequestIn called`);

    if (!body || !body.messages) {
      return { body };
    }

    body.messages = body.messages.map((msg, idx) => {
      // Only touch Assistant messages
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
            // Keep other blocks (like tool_use) intact
            newContent.push(block);
          }
        });

        if (modificationNeeded) {
          this.log('info', `[${ts}] [XML-Transformer] Converting thinking block in Msg #${idx}`);

          // Wrap thinking in XML
          const xmlThought = `<thinking>\n${thinkingText}\n</thinking>`;

          // Combine: Thought + Text
          const combinedText = `${xmlThought}\n\n${standardText}`;

          // Add to the front of newContent
          newContent.unshift({
            type: 'text',
            text: combinedText
          });

          // Replace the message content
          msg.content = newContent;
        }
      }
      return msg;
    });

    return { body };
  }

  /**
   * Transform outgoing response - pass through unchanged
   */
  async transformResponseOut(response, context) {
    return response;
  }
}

module.exports = XmlThinkingTransformer;
