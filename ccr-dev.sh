#!/usr/bin/env bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build the project
echo "Building latest version..." >&2
(cd "$SCRIPT_DIR" && npm run build > /dev/null 2>&1)

# Check if build succeeded
if [ ! -f "$SCRIPT_DIR/dist/cli.js" ]; then
    echo "Error: Build failed or dist/cli.js not found" >&2
    exit 1
fi

# Run the local CLI with all arguments passed through
node "$SCRIPT_DIR/dist/cli.js" "$@"
