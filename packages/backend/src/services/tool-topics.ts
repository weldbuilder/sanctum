// The built-in `res help <topic>` names. Kept apart from tool-help.ts (which imports the Command
// Center routes) so the plugin loader can reserve them without that import.
export const TOOL_TOPICS = ['chat', 'meal', 'cc', 'presence', 'routine', 'pulse', 'failsafe', 'timer', 'impulse', 'watch', 'ask', 'identity', 'browser', 'tg'] as const;
export type ToolTopic = typeof TOOL_TOPICS[number];
