/**
 * Status tab: the read-only panels (skills, MCPs, usage, logs), Google, and the server and install block. Each folds away until opened,
 * so the page opens short. Nothing here is a daily setting.
 */
import React from 'react';
import { Disclosure } from './Disclosure';
import { SkillsStatusSection } from './SkillsStatusSection';
import { McpSection } from './McpSection';
import { UsageSection } from './UsageSection';
import { LogsSection } from './LogsSection';
import { GoogleSection } from './GoogleSection';
import { InstallBlock } from './InstallBlock';

export function StatusTab({ base, logsQuery }: { base: string; logsQuery: string }) {
  return (
    <div className="status-tab">
      <Disclosure title="server and install" sub="port, updates, setup, raw config" defaultOpen>
        <InstallBlock base={base} />
      </Disclosure>
      <Disclosure title="skills and status" sub="what the companion can do"><SkillsStatusSection base={base} /></Disclosure>
      <Disclosure title="MCP servers" sub="registered tools"><McpSection base={base} /></Disclosure>
      <Disclosure title="usage and model" sub="spend and context"><UsageSection base={base} /></Disclosure>
      <Disclosure title="Google" sub="accounts and apps"><GoogleSection base={base} /></Disclosure>
      <Disclosure title="logs" sub="the server log" open={logsQuery !== ''}><LogsSection base={base} initialQuery={logsQuery} /></Disclosure>
    </div>
  );
}
