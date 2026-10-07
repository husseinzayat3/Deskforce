export interface FileBlock {
  path: string;
  content: string;
}

/** Tags that can only start outside a file, so they end a file block whose closing tag is missing. */
const NEXT_TAG = /\[(?:\/FILE\]|FILE:|SUMMARY\]|ASSIGN:|QUESTION\]|PROJECT:)/i;

/**
 * Splits a response into its file blocks.
 *
 * Models often forget `[/FILE]`. A block therefore ends at its closing tag, or failing that
 * at the next tag that cannot be part of a file (another `[FILE: …]`, `[SUMMARY]`, `[ASSIGN: …]`…),
 * or at the end of the response. Only a block that runs into the end of a response that was
 * cut off by the length limit is reported as `unclosed`: its content really is incomplete.
 */
export const parseFileBlocks = (response: string, truncated = false) => {
  const files: FileBlock[] = [];
  const unclosed: string[] = [];
  const opening = /\[FILE:\s*([^\]\n]+?)\s*\]/gi;
  let match;

  while ((match = opening.exec(response)) !== null) {
    const rest = response.slice(opening.lastIndex);
    const end = rest.search(NEXT_TAG);

    if (end === -1 && truncated) {
      unclosed.push(match[1]);
      continue;
    }
    files.push({ path: match[1], content: (end === -1 ? rest : rest.slice(0, end)).trim() });
  }

  return { files, unclosed };
};
