// Which environment variable holds a dsh run's model API key. One answer for the runner (which lets it through the child's
// environment allowlist) and the adapter (which refuses a public run that has none). '' = a custom route that names no key
// variable: nothing is known, so nothing is checked and nothing extra is passed.
export function routeKeyVar(p: { apiKeyEnv?: string; modelProvider?: string }): string {
  return p.apiKeyEnv || (p.modelProvider && p.modelProvider !== 'deepseek-official' ? '' : 'DEEPSEEK_API_KEY');
}
