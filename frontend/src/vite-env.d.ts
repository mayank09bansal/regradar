/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the RegRadar FastAPI backend, e.g. http://127.0.0.1:8000 */
  readonly VITE_API_BASE_URL?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
