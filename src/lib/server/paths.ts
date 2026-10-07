import path from 'path';

/**
 * Where the database and the generated projects live.
 * The desktop app points OFFICE_DATA_DIR at its own data folder, because an installed app
 * cannot write next to its code. Otherwise it is the `workspace` folder of the checkout.
 */
export const DATA_DIR = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.join(process.cwd(), 'workspace');

export const DB_PATH = path.join(DATA_DIR, 'office_state.db');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
