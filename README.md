# ClawSouls MCP Server

AI agent persona management, safety verification, and memory tools via [Model Context Protocol](https://modelcontextprotocol.io).

**9 tools** for Claude Code, OpenClaw, and any MCP-compatible client.

## Quick Install (Claude Code)

```bash
# Install the ClawSouls plugin (includes MCP server)
/plugin marketplace add https://github.com/clawsouls/clawsouls-claude-code-plugin
/plugin install clawsouls
/reload-plugins
```

Or add directly to your `.mcp.json`:

```json
{
  "mcpServers": {
    "clawsouls": {
      "command": "npx",
      "args": ["-y", "clawsouls-mcp@latest"]
    }
  }
}
```

## Tools

### 🎭 Persona Management

| Tool | Description |
|------|-------------|
| `soul_search` | Search AI agent personas by keyword, category, or tag |
| `soul_get` | Get detailed info about a specific persona |
| `soul_install` | Download a persona and generate CLAUDE.md |

### 🔍 Safety & Integrity

| Tool | Description |
|------|-------------|
| `soul_scan` | SoulScan — verify persona safety against 53 patterns (A+ to F grade) |
| `soul_rollback_check` | Detect persona drift by comparing current vs. baseline files |

### 🧠 Swarm Memory

| Tool | Description |
|------|-------------|
| `memory_search` | **TF-IDF + BM25** ranked search across MEMORY.md + memory/*.md |
| `memory_detail` | Fetch full content of a specific memory section (3-layer step 2) |
| `memory_status` | Show memory file inventory, sizes, and git status |
| `memory_sync` | Git-based multi-agent memory sync (init/push/pull/status) |

## Memory Search

### TF-IDF + BM25 Ranking (Default — Free)

```
memory_search query="SDK version fix"
```

Returns a compact index (~50 tokens per result) ranked by relevance:

```
| # | Location              | Section          | Score |
|---|-----------------------|------------------|-------|
| 1 | memory/2026-03-31.md:5 | SDK 버전 문제 해결 | 2.41  |
| 2 | MEMORY.md:42          | Troubleshooting   | 1.87  |
```

### Enhanced Mode (More tokens, more context)

```
memory_search query="SDK version fix" enhanced=true
```

Returns full snippets with score visualization for top results.

### 3-Layer Workflow (Token Efficient)

```
Step 1: memory_search query="bug fix"        → compact index with scores
Step 2: memory_detail file="memory/2026-03-31.md" line=5  → full section
Step 3: (optional) memory_search enhanced=true  → deep dive
```

~10x token savings compared to loading all memory files.

## Swarm Memory Sync

Share memory across multiple agents via Git:

```
# Initialize (one time)
memory_sync action=init repo_url=git@github.com:user/agent-memory.git

# Push local changes
memory_sync action=push agent_name=brad

# Pull from other agents
memory_sync action=pull

# Check sync status
memory_sync action=status
```

### Compatible Folder Structure

Works with [OpenClaw](https://openclaw.ai)'s memory layout:

```
MEMORY.md              # Long-term curated memory
memory/
  topic-*.md           # Project-specific status/decisions/history
  YYYY-MM-DD.md        # Daily logs
```

## Platforms

| Platform | Integration |
|----------|-------------|
| **Claude Code** | Plugin + MCP — `/clawsouls:*` commands |
| **OpenClaw** | Native SOUL.md support — always-on AI partner |
| **Cursor / Windsurf** | MCP server via `.mcp.json` |
| **Any MCP Client** | `npx -y clawsouls-mcp@latest` |

## Links

- [ClawSouls Platform](https://clawsouls.ai)
- [Claude Code Plugin](https://github.com/clawsouls/clawsouls-claude-code-plugin)
- [Documentation](https://docs.clawsouls.ai)
- [Soul Spec Standard](https://soulspec.org)

## License

MIT
