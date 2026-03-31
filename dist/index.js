#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const API_BASE = "https://clawsouls.ai/api/v1";
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s가-힣ㄱ-ㅎㅏ-ㅣ\-_.]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);
}
function buildCorpus(files) {
    const docs = [];
    for (const [file, content] of Object.entries(files)) {
        const lines = content.split("\n");
        let currentSection = "(top)";
        let sectionStart = 0;
        let sectionLines = [];
        const flushSection = () => {
            if (sectionLines.length === 0)
                return;
            const text = sectionLines.join("\n");
            docs.push({
                file,
                section: currentSection,
                line: sectionStart + 1,
                text,
                tokens: tokenize(text),
            });
        };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^#{1,3}\s/.test(line)) {
                flushSection();
                currentSection = line.replace(/^#+\s*/, "").trim();
                sectionStart = i;
                sectionLines = [line];
            }
            else {
                sectionLines.push(line);
            }
        }
        flushSection();
    }
    return docs;
}
function tfidfSearch(query, docs, limit = 20) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0)
        return [];
    // Build IDF: log(N / df)
    const N = docs.length;
    const df = {};
    for (const doc of docs) {
        const unique = new Set(doc.tokens);
        for (const token of unique) {
            df[token] = (df[token] || 0) + 1;
        }
    }
    const idf = {};
    for (const token of queryTokens) {
        idf[token] = Math.log((N + 1) / ((df[token] || 0) + 1)) + 1; // smoothed IDF
    }
    // Score each document: sum of TF * IDF for query terms
    const scored = [];
    for (const doc of docs) {
        if (doc.tokens.length === 0)
            continue;
        // Term frequency
        const tf = {};
        for (const token of doc.tokens) {
            tf[token] = (tf[token] || 0) + 1;
        }
        let score = 0;
        let matchedTerms = 0;
        for (const qt of queryTokens) {
            if (tf[qt]) {
                // BM25-like TF saturation: tf / (tf + 1.2)
                const tfNorm = tf[qt] / (tf[qt] + 1.2);
                score += tfNorm * (idf[qt] || 1);
                matchedTerms++;
            }
        }
        // Boost for matching more query terms
        if (matchedTerms > 0) {
            score *= (matchedTerms / queryTokens.length);
        }
        // Boost recent files (daily logs)
        const dateMatch = doc.file.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            const daysDiff = (Date.now() - new Date(dateMatch[1]).getTime()) / 86400000;
            if (daysDiff < 7)
                score *= 1.3;
            else if (daysDiff < 30)
                score *= 1.1;
        }
        if (score > 0) {
            // Trim snippet to relevant portion
            const lines = doc.text.split("\n");
            const relevantLines = [];
            for (let i = 0; i < lines.length; i++) {
                if (queryTokens.some((qt) => lines[i].toLowerCase().includes(qt))) {
                    relevantLines.push(i);
                }
            }
            let snippet;
            if (relevantLines.length > 0) {
                const center = relevantLines[0];
                const start = Math.max(0, center - 1);
                const end = Math.min(lines.length, center + 4);
                snippet = lines.slice(start, end).join("\n");
            }
            else {
                snippet = lines.slice(0, 5).join("\n");
            }
            scored.push({
                file: doc.file,
                section: doc.section,
                line: doc.line + (relevantLines[0] || 0),
                snippet,
                score,
            });
        }
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
async function loadMemoryFiles(memoryDir) {
    const { readdirSync, readFileSync, existsSync } = await import("fs");
    const { resolve, join } = await import("path");
    const files = {};
    const dir = resolve(memoryDir);
    // MEMORY.md in parent
    const memoryMd = resolve(dir, "..", "MEMORY.md");
    if (existsSync(memoryMd)) {
        files["MEMORY.md"] = readFileSync(memoryMd, "utf-8");
    }
    // Also check CWD for MEMORY.md
    const cwdMemory = resolve("./MEMORY.md");
    if (existsSync(cwdMemory) && !files["MEMORY.md"]) {
        files["MEMORY.md"] = readFileSync(cwdMemory, "utf-8");
    }
    // memory/*.md
    if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
            if (!file.endsWith(".md"))
                continue;
            files[`memory/${file}`] = readFileSync(join(dir, file), "utf-8");
        }
    }
    return files;
}
// --- API helpers ---
async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok)
        throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
}
async function apiPost(path, body, apiKey) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey)
        headers["X-API-Key"] = apiKey;
    const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
}
// --- Soul Spec file conversion ---
const SECTION_MAP = {
    "SOUL.md": "Persona",
    "IDENTITY.md": "Identity",
    "STYLE.md": "Communication Style",
    "AGENTS.md": "Workflow",
    "HEARTBEAT.md": "Periodic Checks",
};
function filesToClaudeMd(files, meta) {
    const sections = [];
    const name = (meta.displayName || meta.name || "AI Agent");
    const ver = meta.version ? ` v${meta.version}` : "";
    sections.push(`# ${name}${ver}`);
    if (meta.description)
        sections.push(`> ${meta.description}`);
    sections.push("");
    sections.push("<!-- Generated by ClawSouls MCP (clawsouls-mcp) -->");
    sections.push("");
    for (const [filename, sectionTitle] of Object.entries(SECTION_MAP)) {
        const content = files[filename];
        if (content)
            sections.push(`## ${sectionTitle}\n\n${content}\n`);
    }
    return sections.join("\n").trimEnd() + "\n";
}
// --- Server setup ---
const server = new McpServer({
    name: "clawsouls-mcp",
    version: "0.4.0",
});
// Tool: soul_search
server.tool("soul_search", "Search AI agent personas on ClawSouls by keyword, category, or tag", {
    query: z.string().optional().describe("Search keyword"),
    category: z.string().optional().describe("Category filter"),
    limit: z.number().optional().default(20).describe("Max results"),
}, { title: "Search Personas", readOnlyHint: true }, async ({ query, category, limit }) => {
    const params = new URLSearchParams();
    if (query)
        params.set("q", query);
    if (category)
        params.set("category", category);
    if (limit)
        params.set("limit", String(limit));
    const data = await apiGet(`/souls?${params.toString()}`);
    if (!data.souls?.length)
        return { content: [{ type: "text", text: "No souls found." }] };
    const lines = data.souls.map((s, i) => `${i + 1}. **${s.displayName}** (\`${s.owner}/${s.name}\`)\n   ${s.description}\n   ⬇️ ${s.downloads} | ⭐ ${s.avgRating?.toFixed(1) || "N/A"}`);
    return {
        content: [
            { type: "text", text: `Found ${data.souls.length} persona(s):\n\n${lines.join("\n\n")}` },
        ],
    };
});
// Tool: soul_get
server.tool("soul_get", "Get detailed information about a specific persona", {
    owner: z.string().describe("Soul owner (e.g., 'TomLeeLive')"),
    name: z.string().describe("Soul name (e.g., 'brad')"),
}, { title: "Get Persona Details", readOnlyHint: true }, async ({ owner, name }) => {
    const s = await apiGet(`/souls/${owner}/${name}`);
    const text = [
        `# ${s.displayName} (${owner}/${name})`,
        `> ${s.description}`,
        "",
        `- **Version**: ${s.version}`,
        `- **Category**: ${s.category}`,
        `- **Downloads**: ${s.downloads}`,
        `- **Rating**: ${s.avgRating?.toFixed(1) || "N/A"}`,
        s.scanScore != null ? `- **SoulScan**: ${s.scanScore}/100 (${s.scanGrade})` : "",
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }] };
});
// Tool: soul_install
server.tool("soul_install", "Download a persona from ClawSouls and generate a CLAUDE.md file", {
    owner: z.string().describe("Soul owner"),
    name: z.string().describe("Soul name"),
    output_dir: z.string().optional().describe("Output directory (default: current)"),
}, { title: "Install Persona", readOnlyHint: false }, async ({ owner, name, output_dir }) => {
    const bundle = await apiGet(`/bundle/${owner}/${name}`);
    if (!bundle.files || Object.keys(bundle.files).length === 0)
        return { content: [{ type: "text", text: `No files found for "${owner}/${name}".` }] };
    const claudeMd = filesToClaudeMd(bundle.files, bundle.manifest);
    const m = bundle.manifest;
    let writtenPath = null;
    try {
        const { writeFileSync, mkdirSync, existsSync } = await import("fs");
        const { resolve } = await import("path");
        const dir = output_dir || ".";
        const resolvedDir = resolve(dir);
        if (!existsSync(resolvedDir))
            mkdirSync(resolvedDir, { recursive: true });
        writtenPath = resolve(`${dir}/CLAUDE.md`);
        writeFileSync(writtenPath, claudeMd, "utf-8");
    }
    catch {
        writtenPath = null;
    }
    if (writtenPath) {
        return {
            content: [{
                    type: "text",
                    text: `✅ **${m.displayName}** (${owner}/${name} v${m.version}) installed.\nCLAUDE.md written to: \`${writtenPath}\``,
                }],
        };
    }
    return {
        content: [{
                type: "text",
                text: `✅ Downloaded **${m.displayName}**. Save as CLAUDE.md:\n\n\`\`\`markdown\n${claudeMd}\`\`\``,
            }],
    };
});
// Tool: soul_scan
server.tool("soul_scan", "Run SoulScan safety verification on Soul Spec files. Analyzes persona files against 53 safety patterns and returns a grade (A+ to F) with actionable recommendations.", {
    files: z
        .record(z.string())
        .describe('Map of filename to content, e.g. {"SOUL.md": "# My Agent\\n...", "IDENTITY.md": "..."}'),
    api_key: z
        .string()
        .optional()
        .describe("ClawSouls API key (optional, for premium rules)"),
}, { title: "SoulScan Safety Verification", readOnlyHint: true }, async ({ files, api_key }) => {
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
                if (f.suggestion)
                    lines.push(`   → Fix: ${f.suggestion}`);
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
    }
    catch {
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
});
// Tool: soul_rollback_check
server.tool("soul_rollback_check", "Detect persona drift by comparing current Soul Spec files against their original committed versions. Returns drift severity and recommended actions.", {
    current_files: z
        .record(z.string())
        .describe("Current Soul Spec files as {filename: content}"),
    original_files: z
        .record(z.string())
        .describe("Original/baseline Soul Spec files as {filename: content}"),
}, { title: "Soul Rollback — Drift Detection", readOnlyHint: true }, async ({ current_files, original_files }) => {
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
        if (current === original)
            continue;
        const origLines = original.split("\n");
        const currLines = current.split("\n");
        const addedLines = currLines.filter((l) => !origLines.includes(l)).length;
        const removedLines = origLines.filter((l) => !currLines.includes(l)).length;
        const changeRatio = (addedLines + removedLines) / Math.max(origLines.length, 1);
        let severity = "low";
        if (changeRatio > 0.5)
            severity = "high";
        else if (changeRatio > 0.2)
            severity = "medium";
        const criticalPatterns = [
            /safety/i, /boundary/i, /never/i, /forbidden/i, /prohibited/i,
            /must not/i, /do not/i, /restrict/i, /permission/i,
        ];
        const removedCritical = origLines.filter((l) => !currLines.includes(l) && criticalPatterns.some((p) => p.test(l)));
        if (removedCritical.length > 0)
            severity = "high";
        drifts.push({
            file: filename,
            severity,
            addedLines,
            removedLines,
            changeRatio: (changeRatio * 100).toFixed(1) + "%",
            removedCritical: removedCritical.length > 0 ? removedCritical : undefined,
        });
    }
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
        lines.push(`### ${severityEmoji[d.severity]} ${d.file} (${d.severity})`);
        if (d.description) {
            lines.push(`- ${d.description}`);
        }
        else {
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
});
// Tool: memory_search (TF-IDF powered)
server.tool("memory_search", "Search agent memory using TF-IDF ranking. Returns a compact index of matching sections with relevance scores. Use memory_detail to fetch full content of interesting results. Searches MEMORY.md + memory/*.md files.", {
    query: z.string().describe("Natural language search query (e.g. 'SDK version fix', '상표 출원')"),
    memory_dir: z
        .string()
        .optional()
        .describe("Path to memory directory (default: ./memory)"),
    limit: z.number().optional().default(10).describe("Max results (default: 10)"),
    enhanced: z.boolean().optional().default(false).describe("If true, includes full snippets for top results (uses more tokens). Default: compact index only."),
}, { title: "Swarm Memory Search (TF-IDF)", readOnlyHint: true }, async ({ query, memory_dir, limit, enhanced }) => {
    try {
        const files = await loadMemoryFiles(memory_dir || "./memory");
        if (Object.keys(files).length === 0) {
            return {
                content: [{
                        type: "text",
                        text: "⚠️ No memory files found. Create MEMORY.md or memory/*.md files first.",
                    }],
            };
        }
        const corpus = buildCorpus(files);
        const results = tfidfSearch(query, corpus, limit);
        if (results.length === 0) {
            return {
                content: [{ type: "text", text: `No results found for "${query}".` }],
            };
        }
        if (enhanced) {
            // Full snippets mode — more tokens but more context
            const text = results
                .map((r, i) => {
                const scoreBar = "█".repeat(Math.round(r.score * 5));
                return `### ${i + 1}. ${r.file} — ${r.section} (line ${r.line})\n**Score**: ${r.score.toFixed(3)} ${scoreBar}\n\`\`\`\n${r.snippet}\n\`\`\``;
            })
                .join("\n\n");
            return {
                content: [{
                        type: "text",
                        text: `# Memory Search: "${query}"\n**${results.length} results** (TF-IDF + BM25 ranking, enhanced mode)\n\n${text}`,
                    }],
            };
        }
        // Compact index mode — token efficient (~50 tokens/result)
        const rows = results.map((r, i) => `| ${i + 1} | ${r.file}:${r.line} | ${r.section.slice(0, 40)} | ${r.score.toFixed(2)} |`);
        return {
            content: [{
                    type: "text",
                    text: [
                        `# Memory Search: "${query}"`,
                        `**${results.length} results** (TF-IDF + BM25 ranking)`,
                        "",
                        "| # | Location | Section | Score |",
                        "|---|----------|---------|-------|",
                        ...rows,
                        "",
                        "→ Use `memory_detail` with file + line to fetch full content.",
                    ].join("\n"),
                }],
        };
    }
    catch (error) {
        return {
            content: [
                { type: "text", text: `Error searching memory: ${error.message}` },
            ],
        };
    }
});
// Tool: memory_detail (3-layer step 2)
server.tool("memory_detail", "Fetch full content of a specific memory section. Use after memory_search to get details for high-scoring results.", {
    file: z.string().describe("File path from search results (e.g. 'memory/2026-03-31.md' or 'MEMORY.md')"),
    line: z.number().optional().describe("Start line number (from search results)"),
    lines: z.number().optional().default(30).describe("Number of lines to return (default: 30)"),
    memory_dir: z
        .string()
        .optional()
        .describe("Path to memory directory (default: ./memory)"),
}, { title: "Memory Detail", readOnlyHint: true }, async ({ file, line, lines: lineCount, memory_dir }) => {
    try {
        const { readFileSync, existsSync } = await import("fs");
        const { resolve } = await import("path");
        const dir = resolve(memory_dir || ".");
        let filePath;
        if (file === "MEMORY.md") {
            // Try memory_dir parent, then CWD
            const parentPath = resolve(memory_dir || ".", "..", "MEMORY.md");
            const cwdPath = resolve("./MEMORY.md");
            if (existsSync(parentPath))
                filePath = parentPath;
            else if (existsSync(cwdPath))
                filePath = cwdPath;
            else
                return { content: [{ type: "text", text: `❌ MEMORY.md not found.` }] };
        }
        else {
            filePath = resolve(dir, "..", file);
            if (!existsSync(filePath)) {
                filePath = resolve(".", file);
            }
        }
        if (!existsSync(filePath)) {
            return {
                content: [{ type: "text", text: `❌ File not found: ${file}` }],
            };
        }
        const content = readFileSync(filePath, "utf-8");
        const allLines = content.split("\n");
        const startLine = Math.max(0, (line || 1) - 1);
        const endLine = Math.min(allLines.length, startLine + (lineCount || 30));
        const excerpt = allLines.slice(startLine, endLine).join("\n");
        return {
            content: [{
                    type: "text",
                    text: [
                        `# ${file} (lines ${startLine + 1}–${endLine})`,
                        "",
                        "```markdown",
                        excerpt,
                        "```",
                        "",
                        endLine < allLines.length
                            ? `_${allLines.length - endLine} more lines. Use \`line: ${endLine + 1}\` to continue._`
                            : "_End of file._",
                    ].join("\n"),
                }],
        };
    }
    catch (error) {
        return {
            content: [
                { type: "text", text: `Error reading memory: ${error.message}` },
            ],
        };
    }
});
// Tool: memory_status
server.tool("memory_status", "Show current status of agent memory files — list files, sizes, last modified dates, and git status.", {
    memory_dir: z
        .string()
        .optional()
        .describe("Path to memory directory (default: ./memory)"),
}, { title: "Swarm Memory Status", readOnlyHint: true }, async ({ memory_dir }) => {
    try {
        const { readdirSync, statSync, existsSync } = await import("fs");
        const { resolve, join } = await import("path");
        const { execSync } = await import("child_process");
        const dir = resolve(memory_dir || "./memory");
        const files = [];
        const memoryMd = resolve("./MEMORY.md");
        if (existsSync(memoryMd)) {
            const stat = statSync(memoryMd);
            files.push({
                name: "MEMORY.md",
                size: stat.size,
                modified: stat.mtime.toISOString().split("T")[0],
            });
        }
        if (existsSync(dir)) {
            for (const file of readdirSync(dir).sort()) {
                if (!file.endsWith(".md"))
                    continue;
                const stat = statSync(join(dir, file));
                files.push({
                    name: `memory/${file}`,
                    size: stat.size,
                    modified: stat.mtime.toISOString().split("T")[0],
                });
            }
        }
        let gitStatus = "unknown";
        try {
            const status = execSync("git status --porcelain MEMORY.md memory/", {
                encoding: "utf-8",
                timeout: 5000,
            }).trim();
            gitStatus = status || "clean (all committed)";
        }
        catch {
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
            ...files.map((f) => `| ${f.name} | ${(f.size / 1024).toFixed(1)} KB | ${f.modified} |`),
            "",
            "## Git Status",
            "```",
            gitStatus,
            "```",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    catch (error) {
        return {
            content: [
                { type: "text", text: `Error reading memory status: ${error.message}` },
            ],
        };
    }
});
// Tool: memory_sync
server.tool("memory_sync", "Sync agent memory files with a remote Git repository for multi-agent Swarm Memory. Supports init (setup), push (upload changes), pull (download changes), and status.", {
    action: z.enum(["init", "push", "pull", "status"]).describe("init: initialize memory repo & connect remote; push: commit & push local changes; pull: fetch & merge remote changes; status: show sync status"),
    repo_url: z
        .string()
        .optional()
        .describe("Remote Git repo URL (required for init, e.g. git@github.com:user/agent-memory.git)"),
    memory_dir: z
        .string()
        .optional()
        .describe("Path to memory directory (default: ./memory)"),
    agent_name: z
        .string()
        .optional()
        .describe("Agent name for commit messages (default: 'agent')"),
    message: z
        .string()
        .optional()
        .describe("Custom commit message (for push)"),
}, { title: "Swarm Memory Sync", readOnlyHint: false }, async ({ action, repo_url, memory_dir, agent_name, message }) => {
    const { execSync } = await import("child_process");
    const { existsSync, mkdirSync, writeFileSync } = await import("fs");
    const { resolve } = await import("path");
    const dir = resolve(memory_dir || "./memory");
    const name = agent_name || "agent";
    function git(cmd, cwd) {
        try {
            return execSync(`git ${cmd}`, {
                encoding: "utf-8",
                timeout: 30000,
                cwd: cwd || dir,
            }).trim();
        }
        catch (e) {
            throw new Error(`git ${cmd} failed: ${e.message}`);
        }
    }
    try {
        if (action === "init") {
            if (!repo_url) {
                return {
                    content: [{
                            type: "text",
                            text: "❌ `repo_url` is required for init. Example:\n`git@github.com:yourname/agent-memory.git`",
                        }],
                };
            }
            // Create memory dir if needed
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            // Check if already a git repo
            const isGit = existsSync(resolve(dir, ".git"));
            if (!isGit) {
                git("init", dir);
                git(`remote add origin ${repo_url}`, dir);
                // Create initial README
                writeFileSync(resolve(dir, "README.md"), `# Swarm Memory\n\nShared agent memory repository managed by [ClawSouls](https://clawsouls.ai).\n\n> Do not edit files manually — they are managed by AI agents.\n`, "utf-8");
                // Create .gitignore
                writeFileSync(resolve(dir, ".gitignore"), `*.tmp\n*.lock\n.DS_Store\n`, "utf-8");
                git("add -A", dir);
                git(`commit -m "🧠 Swarm Memory initialized by ${name}"`, dir);
                // Try to push (may fail if remote is empty)
                try {
                    git("push -u origin main", dir);
                }
                catch {
                    try {
                        git("branch -M main", dir);
                        git("push -u origin main", dir);
                    }
                    catch (pushErr) {
                        return {
                            content: [{
                                    type: "text",
                                    text: `✅ Local repo initialized at \`${dir}\`\nRemote: \`${repo_url}\`\n\n⚠️ Could not push — make sure the remote repo exists and you have access.\nError: ${pushErr.message}`,
                                }],
                        };
                    }
                }
                return {
                    content: [{
                            type: "text",
                            text: `✅ **Swarm Memory initialized!**\n\n- Local: \`${dir}\`\n- Remote: \`${repo_url}\`\n- Branch: \`main\`\n- Initial commit pushed ✅\n\nOther agents can now \`memory_sync pull\` from the same repo.`,
                        }],
                };
            }
            // Already a git repo — just add/update remote
            try {
                git(`remote set-url origin ${repo_url}`, dir);
            }
            catch {
                git(`remote add origin ${repo_url}`, dir);
            }
            return {
                content: [{
                        type: "text",
                        text: `✅ Remote updated to \`${repo_url}\` for existing repo at \`${dir}\``,
                    }],
            };
        }
        if (action === "push") {
            if (!existsSync(resolve(dir, ".git"))) {
                return {
                    content: [{
                            type: "text",
                            text: "❌ Not a git repo. Run `memory_sync init` first.",
                        }],
                };
            }
            // Stage all memory files
            git("add -A", dir);
            // Check if there are changes
            const status = git("status --porcelain", dir);
            if (!status) {
                return {
                    content: [{
                            type: "text",
                            text: "✅ Nothing to push — memory is already in sync.",
                        }],
                };
            }
            const commitMsg = message || `🧠 Memory sync by ${name} — ${new Date().toISOString().split("T")[0]}`;
            git(`commit -m "${commitMsg}"`, dir);
            git("push", dir);
            const changedFiles = status.split("\n").length;
            return {
                content: [{
                        type: "text",
                        text: `✅ **Pushed ${changedFiles} change(s)**\n\n\`\`\`\n${status}\n\`\`\`\n\nCommit: ${commitMsg}`,
                    }],
            };
        }
        if (action === "pull") {
            if (!existsSync(resolve(dir, ".git"))) {
                // Clone if repo_url provided
                if (repo_url) {
                    git(`clone ${repo_url} ${dir}`, resolve(dir, ".."));
                    return {
                        content: [{
                                type: "text",
                                text: `✅ **Cloned Swarm Memory** from \`${repo_url}\`\n\nLocal: \`${dir}\``,
                            }],
                    };
                }
                return {
                    content: [{
                            type: "text",
                            text: "❌ Not a git repo. Run `memory_sync init` with `repo_url` first.",
                        }],
                };
            }
            const before = git("rev-parse HEAD", dir);
            git("pull --rebase", dir);
            const after = git("rev-parse HEAD", dir);
            if (before === after) {
                return {
                    content: [{
                            type: "text",
                            text: "✅ Already up to date — no new changes from remote.",
                        }],
                };
            }
            const log = git(`log --oneline ${before}..${after}`, dir);
            return {
                content: [{
                        type: "text",
                        text: `✅ **Pulled new changes:**\n\n\`\`\`\n${log}\n\`\`\``,
                    }],
            };
        }
        if (action === "status") {
            if (!existsSync(resolve(dir, ".git"))) {
                return {
                    content: [{
                            type: "text",
                            text: `❌ \`${dir}\` is not a Swarm Memory repo. Run \`memory_sync init\` first.`,
                        }],
                };
            }
            let remote = "none";
            try {
                remote = git("remote get-url origin", dir);
            }
            catch { /* no remote */ }
            const branch = git("branch --show-current", dir);
            const status = git("status --porcelain", dir) || "(clean)";
            const lastCommit = git("log -1 --format=%h\\ %s\\ (%cr)", dir);
            // Check if ahead/behind
            let syncStatus = "unknown";
            try {
                git("fetch --dry-run", dir);
                const ahead = git("rev-list --count origin/main..HEAD", dir);
                const behind = git("rev-list --count HEAD..origin/main", dir);
                syncStatus = `↑ ${ahead} ahead, ↓ ${behind} behind`;
            }
            catch {
                syncStatus = "could not reach remote";
            }
            return {
                content: [{
                        type: "text",
                        text: [
                            "# Swarm Memory Sync Status",
                            "",
                            `- **Local**: \`${dir}\``,
                            `- **Remote**: \`${remote}\``,
                            `- **Branch**: \`${branch}\``,
                            `- **Last commit**: ${lastCommit}`,
                            `- **Sync**: ${syncStatus}`,
                            "",
                            "## Local Changes",
                            "```",
                            status,
                            "```",
                        ].join("\n"),
                    }],
            };
        }
        return {
            content: [{
                    type: "text",
                    text: `❌ Unknown action: ${action}. Use: init, push, pull, or status.`,
                }],
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `❌ Swarm Memory sync error: ${error.message}`,
                }],
        };
    }
});
// --- Start server ---
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
