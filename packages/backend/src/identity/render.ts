import type { CompanionProfile, LoadedCompanionIdentity } from './types.js';

function listBlock(items: string[] | undefined): string {
  if (!items || items.length === 0) return '';
  return items.map(item => `- ${item}`).join('\n');
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) return '';
  return value ? 'yes' : 'no';
}

export function renderStructuredProfile(profile: CompanionProfile): string {
  const sections: string[] = ['# Companion Identity'];

  const companion = profile.companion || {};
  const user = profile.user || {};
  const relationship = profile.relationship || {};
  const voice = profile.voice || {};
  const autonomy = profile.autonomy || {};
  const tools = profile.tools || {};

  const basics = [
    companion.name && `Companion name: ${companion.name}`,
    companion.role && `Role: ${companion.role}`,
    companion.description && `Description: ${companion.description}`,
    user.name && `User name: ${user.name}`,
    user.timezone && `User timezone: ${user.timezone}`,
  ].filter(Boolean);
  if (basics.length > 0) sections.push(basics.join('\n'));

  const relationshipLines = [
    relationship.frame && `Frame: ${relationship.frame}`,
    relationship.continuity_expectation && `Continuity expectation: ${relationship.continuity_expectation}`,
    relationship.boundaries?.length ? `Boundaries:\n${listBlock(relationship.boundaries)}` : '',
  ].filter(Boolean);
  if (relationshipLines.length > 0) sections.push(`## Relationship\n\n${relationshipLines.join('\n')}`);

  const voiceLines = [
    voice.style?.length ? `Style:\n${listBlock(voice.style)}` : '',
    voice.avoid?.length ? `Avoid:\n${listBlock(voice.avoid)}` : '',
  ].filter(Boolean);
  if (voiceLines.length > 0) sections.push(`## Voice\n\n${voiceLines.join('\n\n')}`);

  if (profile.values?.length) sections.push(`## Values\n\n${listBlock(profile.values)}`);
  if (profile.boundaries?.length) sections.push(`## Boundaries\n\n${listBlock(profile.boundaries)}`);

  const autonomyLines = [
    yesNo(autonomy.can_reach_out) && `Can reach out: ${yesNo(autonomy.can_reach_out)}`,
    yesNo(autonomy.use_orchestrator) && `Use orchestrator: ${yesNo(autonomy.use_orchestrator)}`,
    autonomy.checkin_style && `Check-in style: ${autonomy.checkin_style}`,
  ].filter(Boolean);
  if (autonomyLines.length > 0) sections.push(`## Autonomy\n\n${autonomyLines.join('\n')}`);

  const toolLines = [
    yesNo(tools.use_available_tools_naturally) && `Use available tools naturally: ${yesNo(tools.use_available_tools_naturally)}`,
    yesNo(tools.explain_tool_limits_when_relevant) && `Explain tool limits when relevant: ${yesNo(tools.explain_tool_limits_when_relevant)}`,
    yesNo(tools.prefer_small_reviewable_changes) && `Prefer small reviewable changes: ${yesNo(tools.prefer_small_reviewable_changes)}`,
  ].filter(Boolean);
  if (toolLines.length > 0) sections.push(`## Tool Use\n\n${toolLines.join('\n')}`);

  return sections.join('\n\n');
}

/** Fill the names into an identity text: `{{companion_name}}` / `{{user_name}}`,
 *  and the starter file's literal placeholder "(configured in sanctum.yaml)"
 *  after "Name:", which the real run showed reaching the model untouched. */
export function fillIdentityNames(text: string, names: { companion_name: string; user_name: string }): string {
  return String(text || '')
    .replace(/\{\{\s*companion_name\s*\}\}/g, names.companion_name)
    .replace(/\{\{\s*user_name\s*\}\}/g, names.user_name)
    .replace(/(\*\*Name:\*\*\s*)\(configured in (?:sanctum|resonant)\.ya?ml\)/g, `$1${names.companion_name}`);
}

export function renderIdentityPrompt(identity: LoadedCompanionIdentity): string {
  if (identity.mode === 'legacy-claude') {
    return identity.legacyPrompt;
  }
  return identity.text.trim();
}

export function describeIdentitySource(identity: LoadedCompanionIdentity): string {
  if (identity.mode === 'legacy-claude') {
    return identity.sourcePaths.legacyClaude
      ? `legacy CLAUDE.md at ${identity.sourcePaths.legacyClaude}`
      : 'empty legacy CLAUDE.md fallback';
  }
  const files = identity.sourcePaths.files ?? [];
  const where = `${identity.sourcePaths.folder ?? 'identity'}: ${files.join(', ')}`;
  if (files.length === 0) return 'empty identity folder';
  return identity.ratifiedServed ? `${where} (the ratified copy${identity.state === 'pending' ? '; a change is waiting' : ''})` : `${where}${identity.state === 'unratified' ? ' (not yet ratified)' : ''}`;
}
