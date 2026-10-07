/**
 * Replaces one passage of a file with another, the way an agent's `edit_file` call asks for.
 * Throws with a message the model can act on when the passage is missing or ambiguous.
 */
export const applyEdit = (content: string, oldText: string, newText: string, replaceAll = false) => {
  if (!oldText) throw new Error('old_text is empty. Give the exact text to replace, or use write_file to write the whole file.');
  if (oldText === newText) throw new Error('old_text and new_text are the same, so nothing would change.');

  const count = content.split(oldText).length - 1;
  if (count === 0) {
    // The most common miss is indentation or line endings: say so when that is what happened
    const loose = (text: string) => text.replace(/\s+/g, ' ').trim();
    const hint = loose(content).includes(loose(oldText))
      ? ' The words are there but the spacing or line breaks differ: copy the passage exactly as read_file shows it.'
      : ' Read the file again: it may have changed.';
    throw new Error(`old_text was not found in the file.${hint}`);
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`old_text appears ${count} times. Include more of the surrounding lines so it matches one place only, or set replace_all to true.`);
  }

  return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
};
