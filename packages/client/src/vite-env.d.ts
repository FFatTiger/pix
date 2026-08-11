/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SW_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
