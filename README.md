# Symphony

**One interface to orchestrate all your Claude Code instances.**

Symphony is a CLI/TUI that manages multiple Claude Code workers across multiple projects from a single terminal. Describe what you want in natural language, and Symphony's orchestrator decomposes the work, spawns workers in isolated git worktrees, reviews plans and output, and manages the full lifecycle — all without leaving one terminal.

> **Status:** Early development. Not yet ready for use.

## The Problem

If you use Claude Code seriously, you've been here: 10+ terminals open, each running Claude on different projects or features. You're the bottleneck — prompting each one, reviewing output, context-switching constantly. Agent Teams helps within a single project, but doesn't scale across your portfolio.

## What Symphony Does

- **Single interface** — Talk to one orchestrator that manages everything
- **Multi-project** — Register all your projects, route tasks to the right one
- **Autonomous workers** — Each worker is a full `claude -p` instance with its own context window, CLAUDE.md, and MCP servers
- **Worktree isolation** — Every worker gets its own git worktree. No file conflicts, true parallel development
- **Quality pipeline** — Research → Plan → Review Plan → Implement → Test → Review. Workers follow a structured process, not just "do the thing"
- **Smart prompting** — Role-specific prompt templates (researcher, planner, implementer, reviewer) that enforce best practices
- **Rate-limit aware** — Intelligent queuing and staggering so you don't burn through your Max subscription limits
- **Persistent state** — Tasks, workers, and sessions survive across restarts via SQLite
- **No API costs** — Runs entirely on `claude -p` (your existing Claude Max subscription)

## Planned Features

- TUI dashboard with real-time worker output streaming
- Notion and Obsidian integration for task sourcing
- Voice input
- GitHub integration (auto-create PRs from worker output)
- Cross-project coordination

## Tech Stack

- **TypeScript** + **Node.js**
- **Ink** (React for terminal UIs) for the TUI dashboard
- **better-sqlite3** for state persistence
- **simple-git** for worktree management
- **@modelcontextprotocol/sdk** for custom MCP tools

## Requirements

- **Claude Code** CLI installed and authenticated
- **Claude Max** subscription (or API key)
- **Node.js** 20+
- **Git** (for worktree support)
- **pnpm** (package manager)

## Installation

> Coming soon. Symphony is in early development.

```bash
# Clone the repo
git clone https://github.com/chrismdemian/symphony.git
cd symphony

# Install dependencies
pnpm install

# Build
pnpm build

# Run
pnpm start
```

## Usage

> Coming soon.

```bash
# Start Symphony
symphony start

# Register a project
symphony add ~/projects/my-app

# List registered projects
symphony list
```

## Contributing

Contributions welcome once the project reaches a stable foundation. Check back soon.

## License

MIT
