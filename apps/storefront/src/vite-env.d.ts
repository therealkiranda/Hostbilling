/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the HostBilling API. Defaults to /api. */
  readonly VITE_API_URL?: string;
  /** Provider slug to use when the address has no provider in its path. */
  readonly VITE_TENANT_SLUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
