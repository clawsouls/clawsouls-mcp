export declare const START = "<!-- clawsouls:soul:start -->";
export declare const END = "<!-- clawsouls:soul:end -->";
/**
 * Merge a managed persona block into a Markdown file. Never destroys user content:
 *   - File absent → create it containing only the managed block.
 *   - Both markers present → replace only START..END, keeping what is around it.
 *   - No markers → append the block after the existing content.
 * Returns "created" | "replaced" | "appended".
 */
export declare function mergeMarkerSection(filePath: string, content: string): "created" | "replaced" | "appended";
