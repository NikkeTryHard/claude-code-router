# Claude Code Router - Debug System & Thinking Block Fix

## Summary

This implementation adds three major features to Claude Code Router:

1. **Comprehensive Trace Logging System** - Detailed request/response logging for debugging
2. **Request Replay System** - Save and replay failed requests for testing
3. **Thinking Block Signature Preservation** - Fix for multi-turn conversations with thinking blocks

## Features Implemented

### 1. Trace Logging System

**Files:**

- `src/middleware/trace.ts` - Trace logging middleware

**Configuration:**

```json
{
  "TRACE_MODE": true,
  "TRACE_INCLUDE_BODIES": true
}
```

**What it logs:**

- Incoming requests (body, headers, metadata)
- Router decisions (model selection, token count)
- Transformer output
- Provider responses
- Final responses
- Errors
- Agent tool executions

**Usage:**

```bash
# View trace logs in real-time
tail -f ~/.claude-code-router/logs/ccr-*.log | grep TRACE | jq

# Filter by stage
tail -f ~/.claude-code-router/logs/ccr-*.log | grep TRACE | jq 'select(.TRACE.stage == "error")'

# Filter by request ID
tail -f ~/.claude-code-router/logs/ccr-*.log | grep TRACE | jq 'select(.TRACE.reqId == "abc123")'
```

### 2. Request Replay System

**Files:**

- `src/utils/replay.ts` - Replay storage and retrieval
- `src/utils/replayCommand.ts` - CLI command handler
- `src/cli.ts` - CLI integration

**Storage:**

- Location: `~/.claude-code-router/replays/`
- Format: Individual JSON files per request
- Auto-cleanup: Keeps last 50 replays
- Auto-save: Triggers on HTTP 4xx/5xx errors

**CLI Commands:**

```bash
# List all saved replays
ccr replay list

# Run the latest replay
ccr replay run latest

# Run a specific replay
ccr replay run 2026-01-02T12-34-56-789Z_abc123

# Show replay details
ccr replay show 2026-01-02T12-34-56-789Z_abc123

# View statistics
ccr replay stats

# Clear all replays
ccr replay clear
```

**Replay File Structure:**

```json
{
  "id": "2026-01-02T12-34-56-789Z_abc123",
  "timestamp": "2026-01-02T12:34:56.789Z",
  "reqId": "req_123",
  "url": "/v1/messages",
  "method": "POST",
  "headers": {...},
  "body": {...},
  "error": {
    "statusCode": 400,
    "message": "Invalid signature in thinking block",
    "response": {...}
  },
  "metadata": {
    "model": "claude-opus-4-5-thinking",
    "provider": "gcli2api",
    "sessionId": "session_123"
  }
}
```

### 3. Thinking Block Signature Preservation

**Files:**

- `src/index.ts` - Modified SSE stream processing (lines 213-281)

**What was fixed:**

- Captures thinking blocks from SSE stream events
- Preserves thinking content and signatures
- Includes thinking blocks in message reconstruction for agent tool calls
- Maintains correct order (thinking blocks must come first)

**How it works:**

1. Monitors SSE stream for `content_block_start` with `type: "thinking"`
2. Captures thinking content from `thinking_delta` events
3. Captures signature from `signature_delta` events
4. Finalizes thinking block on `content_block_stop`
5. Adds thinking block to assistant messages (using `unshift` to ensure it comes first)
6. When reconstructing messages for recursive calls, thinking blocks are preserved

**Before (broken):**

```javascript
// Only tool_use blocks were included
req.body.messages.push({
  role: 'assistant',
  content: [
    { type: "tool_use", id: "...", name: "...", input: {...} }
  ]
})
```

**After (fixed):**

```javascript
// Thinking blocks with signatures are preserved
req.body.messages.push({
  role: 'assistant',
  content: [
    { type: "thinking", thinking: "...", signature: "..." },
    { type: "tool_use", id: "...", name: "...", input: {...} }
  ]
})
```

## Testing

### Enable Trace Mode

1. Edit your config file (`~/.claude-code-router/config.json`):

```json
{
  "TRACE_MODE": true,
  "TRACE_INCLUDE_BODIES": true
}
```

2. Restart the service:

```bash
ccr restart
```

3. Monitor logs:

```bash
tail -f ~/.claude-code-router/logs/ccr-*.log | grep TRACE | jq
```

### Test Thinking Block Preservation

1. Use a model with thinking enabled (e.g., `claude-opus-4-5-thinking`)
2. Make a multi-turn conversation with agent tool calls
3. Check that no "Invalid signature" errors occur
4. If errors occur, they will be auto-saved to replays

### Test Replay System

1. Trigger an error (or wait for one to occur naturally)
2. List replays:

```bash
ccr replay list
```

3. Re-run the failed request:

```bash
ccr replay run latest
```

4. Verify the request executes correctly (or shows the same error)

## Configuration Reference

### New Config Options

```json
{
  "TRACE_MODE": false, // Enable trace logging
  "TRACE_INCLUDE_BODIES": false // Include full request/response bodies in traces
}
```

### Existing Config (unchanged)

```json
{
  "LOG": true,
  "LOG_LEVEL": "info",
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "APIKEY": "your-ccr-api-key"
}
```

## Debugging Workflow

### When an error occurs:

1. **Check if replay was saved:**

```bash
ccr replay list
```

2. **View the replay details:**

```bash
ccr replay show <replay-id>
```

3. **Enable trace mode** (if not already enabled):

```json
{
  "TRACE_MODE": true,
  "TRACE_INCLUDE_BODIES": true
}
```

4. **Re-run the request:**

```bash
ccr replay run <replay-id>
```

5. **Monitor trace logs:**

```bash
tail -f ~/.claude-code-router/logs/ccr-*.log | grep TRACE | jq
```

6. **Analyze the trace:**

- Check `stage: "incoming"` - Original request
- Check `stage: "router"` - Model selection
- Check `stage: "transformer"` - Transformed request
- Check `stage: "provider"` - Provider response
- Check `stage: "error"` - Error details

## Files Changed

### New Files

- `src/middleware/trace.ts` - Trace logging middleware
- `src/utils/replay.ts` - Replay storage/retrieval
- `src/utils/replayCommand.ts` - Replay CLI commands

### Modified Files

- `src/index.ts` - Added thinking block preservation, trace logging, replay auto-save
- `src/cli.ts` - Added replay command
- `config.gcli2api.example.json` - Added trace config options

## Performance Considerations

- **Trace logging:** Minimal overhead when disabled. When enabled with `TRACE_INCLUDE_BODIES`, can increase log file size significantly.
- **Replay storage:** Each replay is ~1-10KB. With 50 max replays, total storage is ~50-500KB.
- **Thinking block preservation:** No performance impact. Only processes thinking blocks when they exist in the stream.

## Known Limitations

1. **Replay deduplication:** Currently saves one replay per error. If gcli2api retries multiple times, only the first error is saved (as intended).
2. **Trace log rotation:** Uses existing rotating-file-stream configuration (3 files, 1 day interval, 50MB max).
3. **Thinking block preservation:** Only works for agent tool calls. Regular multi-turn conversations without agent tools don't need this fix.

## Next Steps

1. Test with gcli2api and thinking-enabled models
2. Verify no "Invalid signature" errors occur
3. Test replay system with various error scenarios
4. Monitor trace logs for any unexpected behavior
5. Adjust `TRACE_MODE` and `TRACE_INCLUDE_BODIES` based on debugging needs
