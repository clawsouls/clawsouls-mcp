import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
// Same markers as the clawsouls CLI (src/commands/install.ts mergeMarkerSection),
// so a persona installed by either tool is replaced, not duplicated, by the other.
export const START = "<!-- clawsouls:soul:start -->";
export const END = "<!-- clawsouls:soul:end -->";
/**
 * Merge a managed persona block into a Markdown file. Never destroys user content:
 *   - File absent → create it containing only the managed block.
 *   - Both markers present → replace only START..END, keeping what is around it.
 *   - No markers → append the block after the existing content.
 * Returns "created" | "replaced" | "appended".
 */
export function mergeMarkerSection(filePath, content) {
    const block = `${START}\n${content}\n${END}`;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
        writeFileSync(filePath, `${block}\n`, "utf-8");
        return "created";
    }
    const existing = readFileSync(filePath, "utf-8");
    const startIdx = existing.indexOf(START);
    const endIdx = existing.indexOf(END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        writeFileSync(filePath, `${existing.slice(0, startIdx)}${block}${existing.slice(endIdx + END.length)}`, "utf-8");
        return "replaced";
    }
    writeFileSync(filePath, `${existing}\n\n${block}`, "utf-8");
    return "appended";
}
