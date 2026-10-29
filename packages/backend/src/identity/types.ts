export interface CompanionProfile {
  version?: number;
  companion?: {
    name?: string;
    role?: string;
    description?: string;
  };
  user?: {
    name?: string;
    timezone?: string;
  };
  relationship?: {
    frame?: string;
    continuity_expectation?: string;
    boundaries?: string[];
  };
  voice?: {
    style?: string[];
    avoid?: string[];
  };
  values?: string[];
  boundaries?: string[];
  autonomy?: {
    can_reach_out?: boolean;
    use_orchestrator?: boolean;
    checkin_style?: string;
  };
  tools?: {
    use_available_tools_naturally?: boolean;
    explain_tool_limits_when_relevant?: boolean;
    prefer_small_reviewable_changes?: boolean;
  };
}

export interface LoadedCompanionIdentity {
  /** `profile`: the home's identity folder was read. `legacy-claude`: the home has no identity folder, so the old CLAUDE.md lookup ran. */
  mode: 'profile' | 'legacy-claude';
  /** `profile` mode: the rendered identity block (names not filled in yet). */
  text: string;
  legacyPrompt: string;
  /** `profile` mode: the ratification state at the check that read it (absent when no ledger folder is configured). */
  state?: 'ok' | 'pending' | 'unratified' | 'unavailable' | 'legacy';
  /** The ratified copy was read instead of the live folder. */
  ratifiedServed?: boolean;
  sourcePaths: {
    /** The identity folder that was read, and the files in it. */
    folder?: string;
    files?: string[];
    legacyClaude?: string;
  };
}
