import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ClaudeSessionScanner } from '../utils/index.js';
import type { ExistingClaudeSession } from '../utils/ClaudeSessionScanner.js';
import type { ReportingConfig } from '../types/index.js';
import type { RunContext, RunEvent, RunInputMessage, RunRecord, RunToolEvent } from './RunTracker.js';

interface HistoricalRunImporterOptions {
  projectPath: string;
  runIndex?: number;
  sessionIdPrefix?: string;
  includeGeneral?: boolean;
}

export interface HistoricalRunSelection {
  run: RunRecord;
  runIndex: number;
  totalRuns: number;
  projectPath: string;
  sessionId: string;
}

interface InternalRunState {
  run: RunRecord;
  toolsByUseId: Map<string, RunToolEvent>;
  sawBabysitterSignal: boolean;
}

const DEFAULT_CONFIG: ReportingConfig = {
  enabled: true,
  autoSend: true,
  babysitterOnly: true,
  maxRunsPerSession: 25,
  maxOutputChars: 12000,
  maxEvents: 200,
  maxToolInputChars: 2000,
  maxFileSizeMB: 45,
};

type JsonObject = Record<string, unknown>;

export class HistoricalRunImporter {
  private readonly scanner: ClaudeSessionScanner;
  private readonly config: ReportingConfig;

  constructor(config?: Partial<ReportingConfig>) {
    this.scanner = new ClaudeSessionScanner();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async findRun(options: HistoricalRunImporterOptions): Promise<HistoricalRunSelection | null> {
    const runs = await this.listRuns(options);
    if (runs.length === 0) {
      return null;
    }

    const targetIndex = Math.max(1, options.runIndex ?? 1);
    return runs[targetIndex - 1] ?? null;
  }

  async listRuns(options: HistoricalRunImporterOptions): Promise<HistoricalRunSelection[]> {
    const normalizedProject = this.normalizeProjectPath(options.projectPath);
    const includeGeneral = options.includeGeneral ?? false;
    const sessionIdPrefix = options.sessionIdPrefix?.trim();

    let sessions = this.scanner.getProjectSessions(normalizedProject);
    if (sessionIdPrefix) {
      sessions = sessions.filter((session) => session.sessionId.startsWith(sessionIdPrefix));
    }

    if (sessions.length === 0) {
      return [];
    }

    const allRuns: Array<{ run: RunRecord; sessionId: string }> = [];
    for (const session of sessions) {
      const runs = await this.parseSessionRuns(session, normalizedProject);
      for (const run of runs) {
        if (includeGeneral || run.runType === 'babysitter') {
          allRuns.push({ run, sessionId: session.sessionId });
        }
      }
    }

    allRuns.sort((a, b) => b.run.startedAt - a.run.startedAt);

    const total = allRuns.length;
    return allRuns.map((entry, index) => ({
      run: entry.run,
      runIndex: index + 1,
      totalRuns: total,
      projectPath: normalizedProject,
      sessionId: entry.sessionId,
    }));
  }

  private async parseSessionRuns(session: ExistingClaudeSession, projectPath: string): Promise<RunRecord[]> {
    const runs: RunRecord[] = [];
    let active: InternalRunState | null = null;
    let runCounter = 0;
    let lastTimestamp = session.timestamp.getTime();

    const stream = fs.createReadStream(session.filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let entry: JsonObject;
        try {
          entry = JSON.parse(trimmed) as JsonObject;
        } catch {
          continue;
        }

        const timestamp = this.parseTimestamp(entry['timestamp'], lastTimestamp);
        lastTimestamp = timestamp;

        const userInput = this.extractUserInput(entry);
        if (userInput) {
          if (!active) {
            runCounter += 1;
            active = this.startRun(session, projectPath, userInput, timestamp, runCounter);
          } else {
            this.appendFollowup(active.run, userInput, timestamp);
          }
        }

        if (!active) {
          continue;
        }

        this.processEntry(active, entry, timestamp);

        const entryType = this.getString(entry['type']);
        const subtype = this.getString(entry['subtype']);
        if (entryType === 'system' && subtype === 'turn_duration') {
          this.completeRun(active, timestamp, 'turn_duration');
          runs.push(active.run);
          active = null;
        }
      }
    } finally {
      rl.close();
      stream.close();
    }

    if (active) {
      this.completeRun(active, lastTimestamp, 'eof');
      runs.push(active.run);
    }

    return runs;
  }

  private processEntry(active: InternalRunState, entry: JsonObject, timestamp: number): void {
    const entryType = this.getString(entry['type']);
    if (!entryType) return;

    switch (entryType) {
      case 'assistant': {
        this.consumeAssistantEntry(active, entry, timestamp);
        break;
      }
      case 'user': {
        this.consumeUserToolResults(active, entry, timestamp);
        break;
      }
      case 'progress': {
        this.consumeProgressEntry(active, entry, timestamp);
        break;
      }
      case 'system': {
        const subtype = this.getString(entry['subtype']);
        if (subtype && subtype !== 'turn_duration') {
          this.addEvent(active.run, {
            type: `system_${subtype}`,
            timestamp,
          });
        }
        break;
      }
      case 'error': {
        const detail = this.safeStringify(entry);
        active.run.errors.push(this.truncate(detail, 400));
        this.addEvent(active.run, {
          type: 'error',
          timestamp,
          detail: this.truncate(detail, 200),
        });
        break;
      }
      default:
        break;
    }
  }

  private consumeAssistantEntry(active: InternalRunState, entry: JsonObject, timestamp: number): void {
    const message = this.asObject(entry['message']);
    if (!message) return;

    const content = message['content'];
    let sawAssistantOutput = false;

    if (typeof content === 'string') {
      this.appendOutput(active.run, content);
      sawAssistantOutput = true;
    } else if (Array.isArray(content)) {
      for (const rawBlock of content) {
        const block = this.asObject(rawBlock);
        if (!block) continue;
        const blockType = this.getString(block['type']);
        if (blockType === 'text') {
          const text = this.getString(block['text']);
          if (text) {
            this.appendOutput(active.run, text);
            sawAssistantOutput = true;
          }
          continue;
        }

        if (blockType === 'tool_use') {
          const name = this.getString(block['name']) ?? 'unknown_tool';
          const toolUseId = this.getString(block['id']);
          const input = this.asObject(block['input']) ?? undefined;
          this.startTool(active, name, timestamp, input, toolUseId);
          if (name === 'Task') {
            active.sawBabysitterSignal = true;
            active.run.runType = 'babysitter';
          }
          sawAssistantOutput = true;
        }
      }
    }

    if (sawAssistantOutput) {
      this.addEvent(active.run, {
        type: 'assistant',
        timestamp,
      });
    }
  }

  private consumeUserToolResults(active: InternalRunState, entry: JsonObject, timestamp: number): void {
    const message = this.asObject(entry['message']);
    if (!message) return;

    const content = message['content'];
    if (!Array.isArray(content)) return;

    for (const rawBlock of content) {
      const block = this.asObject(rawBlock);
      if (!block) continue;
      if (this.getString(block['type']) !== 'tool_result') continue;

      const toolUseId = this.getString(block['tool_use_id']);
      const isError = this.getBoolean(block['is_error']) ?? false;
      const detail = this.getString(block['content']);
      this.finishTool(active, timestamp, toolUseId, isError, detail);
    }
  }

  private consumeProgressEntry(active: InternalRunState, entry: JsonObject, timestamp: number): void {
    const data = this.asObject(entry['data']);
    if (!data) return;

    const progressType = this.getString(data['type']);
    if (!progressType) return;

    if (progressType === 'hook_progress') {
      const hookEvent = this.getString(data['hookEvent']) ?? 'unknown';
      const hookName = this.getString(data['hookName']) ?? 'hook';
      const command = this.getString(data['command']) ?? '';
      this.addEvent(active.run, {
        type: 'hook_progress',
        timestamp,
        detail: `${hookEvent}:${hookName}`,
      });

      if (command.includes('babysitter')) {
        active.sawBabysitterSignal = true;
        active.run.runType = 'babysitter';
      }
      return;
    }

    if (progressType === 'agent_progress') {
      active.sawBabysitterSignal = true;
      active.run.runType = 'babysitter';
      const agentId = this.getString(data['agentId']);
      this.addEvent(active.run, {
        type: 'agent_progress',
        timestamp,
        detail: agentId,
      });

      const nestedMessage = this.asObject(data['message']);
      if (!nestedMessage) return;

      const nestedTimestamp = this.parseTimestamp(nestedMessage['timestamp'], timestamp);
      const nestedType = this.getString(nestedMessage['type']);
      if (nestedType === 'assistant') {
        this.consumeAssistantEntry(active, nestedMessage, nestedTimestamp);
      } else if (nestedType === 'user') {
        this.consumeUserToolResults(active, nestedMessage, nestedTimestamp);
      }
      return;
    }

    this.addEvent(active.run, {
      type: `progress_${progressType}`,
      timestamp,
    });
  }

  private startRun(
    session: ExistingClaudeSession,
    projectPath: string,
    input: string,
    timestamp: number,
    runCounter: number
  ): InternalRunState {
    const context: RunContext = {
      sessionName: session.sessionId,
      workingDir: projectPath,
    };

    const run: RunRecord = {
      id: `hist-${session.sessionId.slice(0, 8)}-${String(runCounter).padStart(3, '0')}`,
      sessionId: session.sessionId,
      runType: this.resolveRunType(input),
      startedAt: timestamp,
      context,
      inputs: [{
        text: input,
        timestamp,
        isFollowup: false,
      }],
      toolEvents: [],
      events: [],
      outputText: '',
      errors: [],
    };

    this.addEvent(run, {
      type: 'run_start',
      timestamp,
      detail: this.truncate(input, 200),
    });

    return {
      run,
      toolsByUseId: new Map(),
      sawBabysitterSignal: run.runType === 'babysitter',
    };
  }

  private appendFollowup(run: RunRecord, input: string, timestamp: number): void {
    const nextInput: RunInputMessage = {
      text: input,
      timestamp,
      isFollowup: true,
    };
    run.inputs.push(nextInput);
    this.addEvent(run, {
      type: 'user_followup',
      timestamp,
      detail: this.truncate(input, 200),
    });
  }

  private completeRun(active: InternalRunState, timestamp: number, reason: string): void {
    for (const tool of active.run.toolEvents) {
      if (!tool.endedAt) {
        tool.endedAt = timestamp;
        if (tool.success === undefined) {
          tool.success = true;
        }
      }
    }

    if (active.sawBabysitterSignal) {
      active.run.runType = 'babysitter';
    }

    active.run.endedAt = timestamp;
    active.run.durationMs = Math.max(0, timestamp - active.run.startedAt);
    this.addEvent(active.run, {
      type: 'run_complete',
      timestamp,
      detail: reason,
    });
  }

  private startTool(
    active: InternalRunState,
    name: string,
    timestamp: number,
    input?: JsonObject,
    toolUseId?: string
  ): void {
    if (toolUseId && active.toolsByUseId.has(toolUseId)) {
      return;
    }

    const toolEvent: RunToolEvent = {
      id: toolUseId ?? `tool-${active.run.toolEvents.length + 1}`,
      name,
      startedAt: timestamp,
      input: input ? this.truncate(this.safeStringify(input), this.config.maxToolInputChars) : undefined,
    };
    active.run.toolEvents.push(toolEvent);
    if (toolUseId) {
      active.toolsByUseId.set(toolUseId, toolEvent);
    }

    this.addEvent(active.run, {
      type: 'tool_start',
      timestamp,
      detail: name,
    });
  }

  private finishTool(
    active: InternalRunState,
    timestamp: number,
    toolUseId: string | undefined,
    isError: boolean,
    detail?: string
  ): void {
    let tool: RunToolEvent | undefined;
    if (toolUseId) {
      tool = active.toolsByUseId.get(toolUseId);
    }

    if (!tool) {
      tool = [...active.run.toolEvents].reverse().find((event) => !event.endedAt);
    }

    if (!tool) {
      return;
    }

    tool.endedAt = timestamp;
    tool.success = !isError;

    this.addEvent(active.run, {
      type: isError ? 'tool_failed' : 'tool_end',
      timestamp,
      detail: tool.name,
    });

    if (isError && detail) {
      active.run.errors.push(this.truncate(detail, 500));
    }
  }

  private appendOutput(run: RunRecord, text: string): void {
    if (!text) return;
    const remaining = this.config.maxOutputChars - run.outputText.length;
    if (remaining <= 0) return;
    run.outputText += text.length > remaining ? text.slice(0, remaining) : text;
  }

  private addEvent(run: RunRecord, event: RunEvent): void {
    if (run.events.length >= this.config.maxEvents) return;
    run.events.push(event);
  }

  private resolveRunType(input: string): 'babysitter' | 'general' {
    const normalized = input.toLowerCase();
    if (normalized.includes('/babysitter:') || normalized.includes('/babysit')) {
      return 'babysitter';
    }
    return 'general';
  }

  private extractUserInput(entry: JsonObject): string | null {
    if (this.getString(entry['type']) !== 'user') {
      return null;
    }

    if (this.getBoolean(entry['isMeta'])) {
      return null;
    }

    const message = this.asObject(entry['message']);
    if (!message || this.getString(message['role']) !== 'user') {
      return null;
    }

    const content = message['content'];
    if (typeof content === 'string') {
      return this.extractFromUserString(content);
    }

    if (!Array.isArray(content)) {
      return null;
    }

    const textParts: string[] = [];
    for (const rawPart of content) {
      const part = this.asObject(rawPart);
      if (!part) continue;
      if (this.getString(part['type']) === 'text') {
        const text = this.getString(part['text']);
        if (text) textParts.push(text);
      }
    }

    if (textParts.length === 0) {
      return null;
    }

    return this.extractFromUserString(textParts.join('\n'));
  }

  private extractFromUserString(value: string): string | null {
    const text = value.trim();
    if (!text) return null;

    const commandNameMatch = text.match(/<command-name>([^<]+)<\/command-name>/i);
    if (commandNameMatch?.[1]?.toLowerCase().includes('babysitter')) {
      const commandArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/i);
      const commandArgs = commandArgsMatch?.[1]?.trim();
      return commandArgs
        ? `${commandNameMatch[1].trim()} ${commandArgs}`.trim()
        : commandNameMatch[1].trim();
    }

    if (
      /<(local-command-caveat|local-command-stdout|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|task-notification)\b/i
        .test(text)
    ) {
      return null;
    }

    return text;
  }

  private normalizeProjectPath(projectPath: string): string {
    const resolved = path.resolve(projectPath.trim());
    if (resolved.length > 1) {
      return resolved.replace(/\/+$/, '');
    }
    return resolved;
  }

  private parseTimestamp(raw: unknown, fallback: number): number {
    const value = this.getString(raw);
    if (!value) return fallback;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  private asObject(value: unknown): JsonObject | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as JsonObject;
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private getBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }
}
