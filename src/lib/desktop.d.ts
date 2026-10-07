/** Present only inside the desktop app (see electron/preload.js). */
interface DesktopBridge {
  /** Shows a project's folder in the system file manager. */
  openProject: (project: string) => Promise<void>;
}

interface Window {
  desktop?: DesktopBridge;
}
