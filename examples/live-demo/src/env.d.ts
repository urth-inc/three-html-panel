interface ImportMetaEnv {
  /** Where the live demo is served (see vite.config.ts): the switcher's agent talks to it. */
  readonly VITE_HOST_ORIGIN: string;
  /** Where each site it shows is served, by name (see vite.config.ts). */
  readonly VITE_SITES: Record<string, string>;
}
