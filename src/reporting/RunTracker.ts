import { EventEmitter } from 'events';
import { ulid } from 'ulid';
import type { ClaudeOutput, ToolUseOutput, ToolResultOutput, ReportingConfig } from '../types/index.js';

export interface RunContext {
  chatId?: number;
  threadId?: number;
  userId?: number;
  sessionName?: string;
  workingDir?: string;
}

export interface RunInputMessage {
  text: string;
  timestamp: number;
  isFollowup: boolean;
}

export interface RunToolEvent {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  input?: string;
}

export interface RunEvent {
  type: string;
  timestamp: number;
  detail?: string;
}

export interface RunRecord {
  id: string;
  sessionId: string;
  runType: 'babysitter' | 'general';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  context?: RunContext;
  inputs: RunInputMessage[];
  toolEvents: RunToolEvent[];
  events: RunEvent[];
  outputText: string;
  errors: string[];
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

export interface RunTrackerEvents {
  run_complete: (run: RunRecord) => void;
}

export class RunTracker extends EventEmitter {
  private config: ReportingConfig;
  private activeRuns: Map<string, RunRecord> = new Map();
  private completedRuns: Map<string, RunRecord[]> = new Map();

  constructor(config?: Partial<ReportingConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): ReportingConfig {
    return this.config;
  }

  startRun(sessionId: string, input: string, context?: RunContext): RunRecord {
    const existing = this.activeRuns.get(sessionId);
    if (existing && !existing.endedAt) {
      this.completeRun(sessionId, 'interrupted');
    }

    const now = Date.now();
    const run: RunRecord = {
      id: ulid(),
      sessionId,
      runType: 'general',
      startedAt: now,
      context,
      inputs: [{
        text: input,
        timestamp: now,
        isFollowup: false,
      }],
      toolEvents: [],
      events: [],
      outputText: '',
      errors: [],
    };

    this.activeRuns.set(sessionId, run);
    this.addEvent(run, 'run_start', this.truncate(input, 200));
    return run;
  }

  startTypedRun(
    sessionId: string,
    input: string,
    runType: 'babysitter' | 'general',
    context?: RunContext
  ): RunRecord {
    const run = this.startRun(sessionId, input, context);
    run.runType = runType;
    return run;
  }

  appendUserMessage(sessionId: string, input: string, context?: RunContext): RunRecord {
    const run = this.activeRuns.get(sessionId);
    if (!run || run.endedAt) {
      return this.startRun(sessionId, input, context);
    }

    const now = Date.now();
    run.inputs.push({
      text: input,
      timestamp: now,
      isFollowup: true,
    });

    if (!run.context && context) {
      run.context = context;
    }

    this.addEvent(run, 'user_followup', this.truncate(input, 200));
    return run;
  }

  recordOutput(sessionId: string, output: ClaudeOutput): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;

    const timestamp = this.resolveTimestamp(output);

    if (output.type === 'tool_use') {
      const tool = output as ToolUseOutput;
      this.recordToolStart(run, tool.name, timestamp, tool.input);
      return;
    }

    if (output.type === 'tool_result') {
      const result = output as ToolResultOutput & { is_error?: boolean };
      const openTool = [...run.toolEvents].reverse().find(t => !t.endedAt);
      if (openTool) {
        openTool.endedAt = timestamp;
        const failed = Boolean((result as ToolResultOutput).error || result.is_error);
        openTool.success = !failed;
        this.addEvent(run, failed ? 'tool_failed' : 'tool_end', openTool.name);
      } else {
        this.addEvent(run, 'tool_end', 'unknown');
      }
      return;
    }

    if (output.type === 'error') {
      const detail = JSON.stringify(output);
      run.errors.push(detail);
      this.addEvent(run, 'error', this.truncate(detail, 200));
      return;
    }

    if (output.type === 'result') {
      this.addEvent(run, 'result', undefined);
      this.completeRun(sessionId, 'result');
      return;
    }

    if (output.type === 'system') {
      this.addEvent(run, 'system', this.truncate(JSON.stringify(output), 200));
      return;
    }

    if (output.type === 'assistant') {
      this.addEvent(run, 'assistant', undefined);
      return;
    }

    if (output.type === 'message_stop') {
      this.completeRun(sessionId, 'message_stop');
      return;
    }
  }

  recordText(sessionId: string, text: string): void {
    const run = this.activeRuns.get(sessionId);
    if (!run || !text) return;

    const remaining = this.config.maxOutputChars - run.outputText.length;
    if (remaining <= 0) return;

    const chunk = text.length > remaining ? text.slice(0, remaining) : text;
    run.outputText += chunk;
  }

  recordToolCall(sessionId: string, tool: ToolUseOutput): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    const timestamp = Date.now();
    this.recordToolStart(run, tool.name, timestamp, tool.input);
  }

  recordEvent(sessionId: string, type: string, detail?: string): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    this.addEvent(run, type, detail);
  }

  getLatestRun(sessionId: string): RunRecord | null {
    const completed = this.completedRuns.get(sessionId);
    if (completed && completed.length > 0) {
      return completed[completed.length - 1];
    }
    const active = this.activeRuns.get(sessionId);
    return active ?? null;
  }

  findRunById(runId: string): RunRecord | null {
    for (const runs of this.completedRuns.values()) {
      const match = runs.find(r => r.id.startsWith(runId));
      if (match) return match;
    }
    for (const run of this.activeRuns.values()) {
      if (run.id.startsWith(runId)) return run;
    }
    return null;
  }

  completeRun(sessionId: string, reason: string): void {
    const run = this.activeRuns.get(sessionId);
    if (!run || run.endedAt) return;

    const now = Date.now();
    run.endedAt = now;
    run.durationMs = now - run.startedAt;
    this.addEvent(run, 'run_complete', reason);

    this.activeRuns.delete(sessionId);
    const list = this.completedRuns.get(sessionId) ?? [];
    list.push(run);
    if (list.length > this.config.maxRunsPerSession) {
      list.splice(0, list.length - this.config.maxRunsPerSession);
    }
    this.completedRuns.set(sessionId, list);

    this.emit('run_complete', run);
  }

  private addEvent(run: RunRecord, type: string, detail?: string): void {
    if (run.events.length >= this.config.maxEvents) return;
    run.events.push({
      type,
      timestamp: Date.now(),
      detail,
    });
  }

  private resolveTimestamp(output: ClaudeOutput): number {
    if (output.timestamp) {
      const parsed = Date.parse(output.timestamp);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  private recordToolStart(run: RunRecord, name: string, timestamp: number, input?: Record<string, unknown>): void {
    const last = run.toolEvents[run.toolEvents.length - 1];
    if (last && last.name === name && Math.abs(last.startedAt - timestamp) < 50) {
      return;
    }
    const toolEvent: RunToolEvent = {
      id: ulid(),
      name,
      startedAt: timestamp,
      input: this.formatToolInput(input),
    };
    run.toolEvents.push(toolEvent);
    this.addEvent(run, 'tool_start', name);
  }

  private formatToolInput(input?: Record<string, unknown>): string | undefined {
    if (!input) return undefined;
    try {
      const json = JSON.stringify(input, null, 2);
      return this.truncate(json, this.config.maxToolInputChars);
    } catch {
      return undefined;
    }
  }

  private truncate(value: string, max: number): string {
    if (!value || value.length <= max) return value;
    return value.slice(0, max - 3) + '...';
  }
}
