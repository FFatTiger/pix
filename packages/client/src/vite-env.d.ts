/// <reference types="vite/client" />

declare const __PIX_SW_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SW_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
