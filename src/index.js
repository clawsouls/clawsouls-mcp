#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://clawsouls.ai/api/v1";

// --- API helpers ---
async function apiPost(path, body, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Server setup ---
const server = new McpServer({
  name: "clawsouls-mcp",
  version: "0.1.0",
});

// Tool: soul_scan
server.tool(
  "soul_scan",
  "Run SoulScan safety verification on Soul Spec files. Analyzes persona files against 53 safety patterns and returns a grade (A+ to F) with actionable recommendations.",
  {
    files: z
      .record(z.string())
      .describe(
        'Map of filename to content, e.g. {"SOUL.md": "# My Agent\\n...", "IDENTITY.md": "..."}'
      ),
    api_key: z
      .string()
      .optional()
      .describe("ClawSouls API key (optional, for premium rules)"),
  },
  { title: "SoulScan Safety Verification", readOnlyHint: true },
  async ({ files, api_key }) => {
    try {
      const result = await apiPost("/soulscan/scan", { files }, api_key);
      const lines = [
        `# SoulScan Results`,
        "",
        `**Grade**: ${result.grade} (${result.score}/100)`,
        `**Rules passed**: ${result.passed}/${result.total}`,
        "",
      ];

      if (result.failures?.length) {
        lines.push("## Issues Found\n");
        for (const f of result.failures) {
          const severity = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
          lines.push(`${severity} **${f.rule}** (${f.severity})`);
          lines.push(`   ${f.message}`);
          if (f.suggestion) lines.push(`   → Fix: ${f.suggestion}`);
          lines.push("");
        }
      }

      if (result.recommendations?.length) {
        lines.push("## Recommendations\n");
        for (const r of result.recommendations) {
          lines.push(`- ${r}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      // Fallback: local basic analysis
      return {
        content: [
          {
            type: "text",
            text: [
              "⚠️ Could not reach SoulScan API. Running basic local analysis.\n",
              ...Object.entries(files).map(([name, content]) => {
                const issues = [];
                if (!content || content.trim().length < 50)
                  issues.push(`${name}: Content too short (< 50 chars)`);
                if (name === "SOUL.md" && !content.includes("#"))
                  issues.push(`${name}: Missing markdown headers`);
                if (name === "SOUL.md" && content.length > 5000)
                  issues.push(`${name}: Very long (${content.length} chars) — consider trimming`);
                return issues.length
                  ? issues.join("\n")
                  : `${name}: ✅ Basic checks passed`;
              }),
              "\nFor full 53-pattern analysis, ensure ClawSouls API is reachable.",
            ].join("\n"),
          },
        ],
      };
    }
  }
);

// Tool: soul_rollback_check
server.tool(
  "soul_rollback_check",
  "Detect persona drift by comparing current Soul Spec files against their original committed versions. Returns drift severity and recommended actions.",
  {
    current_files: z
      .record(z.string())
      .describe("Current Soul Spec files as {filename: content}"),
    original_files: z
      .record(z.string())
      .describe("Original/baseline Soul Spec files as {filename: content}"),
  },
  { title: "Soul Rollback — Drift Detection", readOnlyHint: true },
  async ({ current_files, original_files }) => {
    const drifts = [];

    for (const [filename, original] of Object.entries(original_files)) {
      const current = current_files[filename];
      if (!current) {
        drifts.push({
          file: filename,
          severity: "high",
          description: "File was deleted",
        });
        continue;
      }
      if (current === original) continue;

      // Calculate simple diff metrics
      const origLines = original.split("\n");
      const currLines = current.split("\n");
      const addedLines = currLines.filter((l) => !origLines.includes(l)).length;
      const removedLines = origLines.filter((l) => !currLines.includes(l)).length;
      const changeRatio = (addedLines + removedLines) / Math.max(origLines.length, 1);

      let severity = "low";
      if (changeRatio > 0.5) severity = "high";
      else if (changeRatio > 0.2) severity = "medium";

      // Check for critical changes
      const criticalPatterns = [
        /safety/i, /boundary/i, /never/i, /forbidden/i, /prohibited/i,
        /must not/i, /do not/i, /restrict/i, /permission/i,
      ];
      const removedCritical = origLines.filter(
        (l) => !currLines.includes(l) && criticalPatterns.some((p) => p.test(l))
      );
      if (removedCritical.length > 0) severity = "high";

      drifts.push({
        file: filename,
        severity,
        addedLines,
        removedLines,
        changeRatio: (changeRatio * 100).toFixed(1) + "%",
        removedCritical: removedCritical.length > 0 ? removedCritical : undefined,
      });
    }

    // Check for new files
    for (const filename of Object.keys(current_files)) {
      if (!original_files[filename]) {
        drifts.push({
          file: filename,
          severity: "low",
          description: "New file added",
        });
      }
    }

    if (drifts.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "✅ **No drift detected.** All persona files match their baseline.",
          },
        ],
      };
    }

    const maxSeverity = drifts.some((d) => d.severity === "high")
      ? "high"
      : drifts.some((d) => d.severity === "medium")
        ? "medium"
        : "low";

    const severityEmoji = { high: "🔴", medium: "🟡", low: "🔵" };
    const lines = [
      `# Soul Rollback — Drift Report`,
      "",
      `**Overall severity**: ${severityEmoji[maxSeverity]} ${maxSeverity.toUpperCase()}`,
      `**Files with drift**: ${drifts.length}`,
      "",
    ];

    for (const d of drifts) {
      lines.push(
        `### ${severityEmoji[d.severity]} ${d.file} (${d.severity})`
      );
      if (d.description) {
        lines.push(`- ${d.description}`);
      } else {
        lines.push(`- Added: ${d.addedLines} lines, Removed: ${d.removedLines} lines (${d.changeRatio} changed)`);
        if (d.removedCritical) {
          lines.push(`- ⚠️ **Critical safety lines removed**:`);
          for (const l of d.removedCritical) {
            lines.push(`  - \`${l.trim()}\``);
          }
        }
      }
      lines.push("");
    }

    if (maxSeverity === "high") {
      lines.push("## ⚠️ Recommended Action");
      lines.push("High-severity drift detected. Consider running `git checkout` on affected persona files to restore the baseline.");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// Tool: memory_search
server.tool(
  "memory_search",
  "Search across agent memory files (MEMORY.md, memory/*.md) for relevant context. Returns matching snippets with file paths.",
  {
    query: z.string().describe("Search query"),
    memory_dir: z
      .string()
      .optional()
      .describe("Path to memory directory (default: ./memory)"),
  },
  { title: "Swarm Memory Search", readOnlyHint: true },
  async ({ query, memory_dir }) => {
    try {
      const { readdirSync, readFileSync, existsSync } = await import("fs");
      const { resolve, join } = await import("path");

      const dir = resolve(memory_dir || "./memory");
      const results = [];
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/);

      // Search MEMORY.md
      const memoryMd = resolve("./MEMORY.md");
      if (existsSync(memoryMd)) {
        const content = readFileSync(memoryMd, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (queryTerms.some((t) => lines[i].toLowerCase().includes(t))) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length, i + 3);
            results.push({
              file: "MEMORY.md",
              line: i + 1,
              snippet: lines.slice(start, end).join("\n"),
            });
          }
        }
      }

      // Search memory/*.md
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const content = readFileSync(join(dir, file), "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (queryTerms.some((t) => lines[i].toLowerCase().includes(t))) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length, i + 3);
              results.push({
                file: `memory/${file}`,
                line: i + 1,
                snippet: lines.slice(start, end).join("\n"),
              });
            }
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
        };
      }

      // Deduplicate and limit
      const unique = results.slice(0, 20);
      const text = unique
        .map((r) => `### ${r.file}:${r.line}\n\`\`\`\n${r.snippet}\n\`\`\``)
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${unique.length} result(s) for "${query}":\n\n${text}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error searching memory: ${error.message}` },
        ],
      };
    }
  }
);

// Tool: memory_status
server.tool(
  "memory_status",
  "Show current status of agent memory files — list files, sizes, last modified dates, and git status.",
  {
    memory_dir: z
      .string()
      .optional()
      .describe("Path to memory directory (default: ./memory)"),
  },
  { title: "Swarm Memory Status", readOnlyHint: true },
  async ({ memory_dir }) => {
    try {
      const { readdirSync, statSync, readFileSync, existsSync } = await import("fs");
      const { resolve, join } = await import("path");
      const { execSync } = await import("child_process");

      const dir = resolve(memory_dir || "./memory");
      const files = [];

      // Check MEMORY.md
      const memoryMd = resolve("./MEMORY.md");
      if (existsSync(memoryMd)) {
        const stat = statSync(memoryMd);
        files.push({
          name: "MEMORY.md",
          size: stat.size,
          modified: stat.mtime.toISOString().split("T")[0],
        });
      }

      // Check memory dir
      if (existsSync(dir)) {
        for (const file of readdirSync(dir).sort()) {
          if (!file.endsWith(".md")) continue;
          const stat = statSync(join(dir, file));
          files.push({
            name: `memory/${file}`,
            size: stat.size,
            modified: stat.mtime.toISOString().split("T")[0],
          });
        }
      }

      // Git status
      let gitStatus = "unknown";
      try {
        const status = execSync("git status --porcelain MEMORY.md memory/", {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        gitStatus = status || "clean (all committed)";
      } catch {
        gitStatus = "not a git repository";
      }

      const lines = [
        "# Swarm Memory Status",
        "",
        `**Total files**: ${files.length}`,
        `**Total size**: ${(files.reduce((a, f) => a + f.size, 0) / 1024).toFixed(1)} KB`,
        "",
        "## Files",
        "",
        "| File | Size | Last Modified |",
        "|------|------|---------------|",
        ...files.map(
          (f) => `| ${f.name} | ${(f.size / 1024).toFixed(1)} KB | ${f.modified} |`
        ),
        "",
        "## Git Status",
        "```",
        gitStatus,
        "```",
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return {
        content: [
          { type: "text", text: `Error reading memory status: ${error.message}` },
        ],
      };
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
