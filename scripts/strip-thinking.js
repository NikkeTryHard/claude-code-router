/**
 * Custom Transformer to strip 'thinking' blocks from message history
 * to prevent 400 Errors from Google/Antigravity API.
 */
module.exports = async function (params) {
  if (!params.messages) return params;

  params.messages = params.messages.map((msg) => {
    // Only process Assistant messages with array content
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Filter out the thinking blocks
      const cleanContent = msg.content.filter(block => block.type !== 'thinking');
      
      // Update the content
      msg.content = cleanContent;
    }
    return msg;
  });

  return params;
};

