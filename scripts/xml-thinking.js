/**
 * XML Thinking Transformer - Aggressive Version
 */
module.exports = async function (params) {
  // Log to the CCR standard output (check via 'ccr logs' or standard out)
  const ts = new Date().toISOString();
  console.log(`[${ts}] [XML-Transformer] INSPECTING MESSAGE...`);

  if (!params.body || !params.body.messages) return params;

  params.body.messages = params.body.messages.map((msg, idx) => {
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
        console.log(`[${ts}] [XML-Transformer] Converting thinking block in Msg #${idx}`);
        
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

  return params;
};