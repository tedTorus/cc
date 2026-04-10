# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Haha is a locally runnable version of Claude Code based on leaked source code, supporting any Anthropic-compatible API (MiniMax, OpenRouter, etc.). The project is a TypeScript/Bun monorepo with a full Ink TUI interface.

## Common Commands

```bash
# Install dependencies
bun install

# Run in interactive TUI mode
./bin/claude-haha

# Run in headless mode (script/CI scenarios)
./bin/claude-haha -p "your prompt here"

# Show help
./bin/claude-haha --help

# Development
bun run docs:dev      # VitePress docs dev server
bun run docs:build   # Build docs

# Recovery CLI mode (if TUI fails)
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha
```

## Architecture

### Entry Flow
```
bin/claude-haha → src/entrypoints/cli.tsx → src/main.tsx
```
- `cli.tsx` handles fast-paths (--version, --dump-system-prompt, daemon, remote-control) before loading main.tsx
- `main.tsx` is the TUI entry point using Commander.js + React/Ink

### Key Directories
- `src/tools/` - Agent tools: BashTool, FileEditTool, GrepTool, GlobTool, AgentTool, WebSearchTool, MCPTool, etc.
- `src/commands/` - Slash commands (89 subdirs): /commit, /review, /lsp, etc.
- `src/skills/` - Skill system for extensible capabilities
- `src/services/` - Service layer: api/, mcp/, oauth/, plugins/, analytics/, rateLimitMocking/
- `src/components/` - React UI components (ink-based TUI)
- `src/ink/` - Terminal rendering engine using Ink
- `src/utils/` - Utilities including teammate.ts, teammateMailbox.ts, swarm/ (multi-agent orchestration)
- `src/channel/` - Remote control channels (Telegram, Feishu, Discord integration)
- `src/voice/` - Voice input functionality

### Memory & Multi-Agent System
- `src/utils/teammate.ts` - Teammate identity management
- `src/utils/swarm/` - Swarm orchestration, backendType detection
- `src/utils/teammateMailbox.ts` - File-based messaging between agents
- `src/services/teamMemorySync/` - Memory sharing between teammates
- Teams use file-based mailbox + team config JSON for coordination

### Environment Variables
```env
ANTHROPIC_API_KEY=sk-xxx          # API Key (x-api-key header)
ANTHROPIC_AUTH_TOKEN=sk-xxx       # Bearer Token (Authorization header)
ANTHROPIC_BASE_URL=https://...    # Custom API endpoint
ANTHROPIC_MODEL=MiniMax-M2.7      # Default model
API_TIMEOUT_MS=300000             # Request timeout (default 10min)
DISABLE_TELEMETRY=1              # Disable telemetry
```
Configuration priority: environment variables > `.env` file > `~/.claude/settings.json`

### Platform-Specific
- Windows requires Git for Windows; use `bun --env-file=.env ./src/entrypoints/cli.tsx`
- macOS/Linux use the `bin/claude-haha` wrapper script
