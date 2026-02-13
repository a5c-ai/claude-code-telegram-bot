import type { ChildProcess } from 'child_process';
import type { EventEmitter } from 'events';

/**
 * Session status types
 */
export type SessionStatus = 'active' | 'idle' | 'waiting_input' | 'error';

/**
 * Represents a Claude Code session
 */
export interface Session {
  id: string;
  name: string;
  workingDir: string;
  status: SessionStatus;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Session with process reference (internal use)
 */
export interface SessionWithProcess extends Session {
  process: ClaudeCodeProcessInterface;
}

/**
 * Interface for ClaudeCodeProcess
 */
export interface ClaudeCodeProcessInterface extends EventEmitter {
  readonly isRunning: boolean;
  send(input: string): void;
  kill(): void;
  writeToStdin(response: string): void;
  hasActiveProcess(): boolean;
}

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
  claudeCliPath?: string;
  defaultWorkingDir?: string;
  contextualSessionConfig?: ContextualSessionConfig;
}

// ============================================================================
// Per-Thread Session Support Types
// ============================================================================

/**
 * Session context for thread-aware session resolution
 * Used to identify the context in which a session should be resolved
 */
export interface SessionContext {
  /** Chat ID where the session is being accessed */
  chatId: number | string;
  /** Thread/topic ID within the chat (for forum topics) */
  threadId?: number;
  /** User ID associated with the session request */
  userId?: number;
}

/**
 * Mapping of thread context to session ID
 * Stores the association between a specific context (chat/thread/user) and a session
 */
export interface ThreadSessionMapping {
  /** Generated key for this context, e.g., "chat:123:thread:456" */
  contextKey: string;
  /** The session ID associated with this context */
  sessionId: string;
  /** Chat ID for this mapping */
  chatId: number | string;
  /** Thread/topic ID if applicable */
  threadId?: number;
  /** User ID if applicable */
  userId?: number;
  /** Timestamp when this mapping was created */
  createdAt: Date;
  /** Timestamp of last activity on this mapping */
  lastActivity: Date;
}

/**
 * Configuration for contextual session support
 * Controls how sessions are resolved based on chat/thread context
 */
export interface ContextualSessionConfig {
  /** Whether contextual session resolution is enabled */
  enabled: boolean;
  /** Whether to fall back to global active session when no context mapping exists */
  fallbackToGlobal: boolean;
  /** Time in milliseconds after which inactive mappings should be cleaned up */
  cleanupInactiveMs?: number;
}

/**
 * Configuration for TelegramBot
 */
export interface TelegramBotConfig {
  token: string;
  allowedUserIds: number[];
  sessionManagerConfig?: SessionManagerConfig;
  streamingConfig?: StreamingConfig;
  threadedModeConfig?: ThreadedModeConfig;
}

/**
 * Question option from Claude Code
 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * Parsed question from Claude Code output
 */
export interface ParsedQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * Pending question with associated session ID
 * Used to track which session asked the question so answers route correctly
 */
export interface PendingQuestionWithSession {
  question: ParsedQuestion;
  sessionId: string;
}

/**
 * Claude Code output event types
 */
export type ClaudeOutputType =
  | 'assistant'
  | 'user'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_start'
  | 'message_delta'
  | 'message_stop'
  | 'result';

/**
 * Base Claude Code output message
 */
export interface ClaudeOutputBase {
  type: ClaudeOutputType;
  timestamp?: string;
}

/**
 * Assistant text output
 */
export interface AssistantOutput extends ClaudeOutputBase {
  type: 'assistant';
  content: string;
}

/**
 * Tool use output
 */
export interface ToolUseOutput extends ClaudeOutputBase {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result output
 */
export interface ToolResultOutput extends ClaudeOutputBase {
  type: 'tool_result';
  name: string;
  result: unknown;
  error?: string;
}

/**
 * Union type for all Claude outputs
 */
export type ClaudeOutput =
  | AssistantOutput
  | ToolUseOutput
  | ToolResultOutput
  | ClaudeOutputBase;

/**
 * Events emitted by OutputParser
 */
export interface OutputParserEvents {
  'question': (question: ParsedQuestion, sessionId: string) => void;
  'output': (output: ClaudeOutput, sessionId: string) => void;
  'tool_call': (tool: ToolUseOutput, sessionId: string) => void;
  'error': (error: Error, sessionId: string) => void;
  'text': (text: string) => void;
  'thinking': () => void;
  'started': () => void;
  'progress': (progress: { type: string; toolName?: string; success?: boolean }) => void;
  'streaming_start': (event: StreamingStartEvent) => void;
  'streaming_delta': (event: StreamingDeltaEvent) => void;
  'streaming_complete': (event: StreamingCompleteEvent) => void;
}

/**
 * Telegram inline keyboard button
 */
export interface InlineButton {
  text: string;
  callback_data: string;
}

/**
 * Formatted message for Telegram
 */
export interface TelegramFormattedMessage {
  text: string;
  parseMode: 'Markdown' | 'HTML';
  replyMarkup?: {
    inline_keyboard: InlineButton[][];
  };
}

/**
 * Verbosity level for output filtering
 */
export type VerbosityLevel = 'minimal' | 'normal' | 'verbose';

/**
 * Notification types
 */
export type NotificationType = 'completion' | 'error' | 'warning' | 'progress';

/**
 * User notification preferences
 */
export type NotificationPreferences = Record<NotificationType, boolean>;

/**
 * Log level types
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Voice configuration
 */
export interface VoiceConfig {
  enabled: boolean;
  openaiApiKey?: string;
}

/**
 * Notification configuration
 */
export interface NotificationConfig {
  defaults: NotificationPreferences;
}

/**
 * Verbosity configuration
 */
export interface VerbosityConfig {
  defaultLevel: VerbosityLevel;
}

/**
 * File upload configuration
 */
export interface FileUploadConfig {
  enabled: boolean;
  maxFileSizeMB: number;
  supportedMimeTypes: string[];
  allowedExtensions: string[];
}

/**
 * Run reporting configuration
 */
export interface ReportingConfig {
  enabled: boolean;
  autoSend: boolean;
  babysitterOnly: boolean;
  maxRunsPerSession: number;
  maxOutputChars: number;
  maxEvents: number;
  maxToolInputChars: number;
  maxFileSizeMB: number;
  previewDir?: string;
}

/**
 * Extended TelegramBot configuration with new features
 */
export interface ExtendedTelegramBotConfig extends TelegramBotConfig {
  voiceConfig?: VoiceConfig;
  notificationConfig?: NotificationConfig;
  verbosityConfig?: VerbosityConfig;
  fileUploadConfig?: FileUploadConfig;
  reportingConfig?: ReportingConfig;
  logLevel?: LogLevel;
}

// ============================================================================
// Telegram Bot API 9.3 - Native AI Chatbot Features
// ============================================================================

/**
 * Options for sendMessageDraft API method
 * Used to show a draft bubble in the chat before the final message is sent
 * @see https://core.telegram.org/bots/api#sendmessagedraft
 */
export interface SendMessageDraftOptions {
  /** Unique identifier for the target chat or username of the target channel */
  chat_id: number | string;
  /** Unique identifier for the target message thread (topic) of the forum; for forum supergroups only */
  message_thread_id?: number;
  /** Text of the draft message to be shown in the chat */
  text: string;
}

/**
 * Streaming mode for AI chatbot responses
 * - 'partial': Stream partial responses as they become available
 * - 'block': Send responses in blocks/chunks
 * - 'off': Disable streaming, send complete responses only
 */
export type StreamingMode = 'partial' | 'block' | 'off';

/**
 * Configuration for forum topic/threaded message mode
 * Required when bot has forum topic mode enabled for private chats
 */
export interface ThreadedModeConfig {
  /** Whether forum topic mode is enabled for this chat */
  enabled: boolean;
  /** Default message thread ID to use when sending messages */
  defaultThreadId?: number;
  /** Whether to automatically create new topics for new conversations */
  autoCreateTopics?: boolean;
  /** Prefix for auto-created topic names */
  topicNamePrefix?: string;
}

/**
 * Context for messages within a forum topic/thread
 */
export interface MessageThreadContext {
  /** Unique identifier for the message thread (topic) */
  message_thread_id: number;
  /** Whether the message is part of a forum topic */
  is_topic_message: boolean;
  /** Name of the forum topic (if available) */
  topic_name?: string;
  /** Icon color of the forum topic */
  topic_icon_color?: number;
  /** Custom emoji ID for the topic icon */
  topic_icon_custom_emoji_id?: string;
}

/**
 * State of a draft bubble shown in chat
 * Used to track the current draft message being displayed to the user
 */
export interface DraftBubbleState {
  /** Whether a draft bubble is currently visible */
  isVisible: boolean;
  /** Current text content of the draft */
  currentText: string;
  /** Chat ID where the draft is shown */
  chatId: number | string;
  /** Message thread ID if in a forum topic */
  messageThreadId?: number;
  /** Timestamp when the draft was last updated */
  lastUpdated: number;
  /** Whether the draft has been finalized/sent */
  isFinalized: boolean;
}

// ============================================================================
// Streaming Configuration Types
// ============================================================================

/**
 * Configuration for streaming AI responses
 */
export interface StreamingConfig {
  /** Streaming mode to use */
  mode: StreamingMode;
  /** Size of blocks when using 'block' mode (in characters) */
  blockSize: number;
  /** Minimum interval between updates in milliseconds */
  updateIntervalMs: number;
  /** Whether streaming is enabled */
  enabled: boolean;
}

/**
 * Represents a chunk of streamed text
 */
export interface StreamChunk {
  /** The text content of this chunk */
  text: string;
  /** Timestamp when this chunk was received */
  timestamp: number;
  /** Whether this is the final chunk (stream complete) */
  isComplete: boolean;
}

/**
 * Current state of a streaming session
 */
export interface StreamState {
  /** Whether streaming is currently in progress */
  isStreaming: boolean;
  /** Accumulated text from all chunks received so far */
  accumulatedText: string;
  /** Timestamp of the last update */
  lastUpdateTime: number;
  /** Chat ID associated with this stream */
  chatId: number | string;
  /** Message thread ID if streaming in a forum topic */
  messageThreadId?: number;
  /** Number of chunks received */
  chunksReceived?: number;
  /** Total bytes received */
  totalBytesReceived?: number;
}

/**
 * Extended TelegramBot configuration with streaming and threading support
 */
export interface StreamingTelegramBotConfig extends ExtendedTelegramBotConfig {
  /** Streaming configuration */
  streamingConfig?: StreamingConfig;
  /** Threaded mode configuration */
  threadedModeConfig?: ThreadedModeConfig;
}

/**
 * Result of a sendMessageDraft API call
 */
export type SendMessageDraftResult = boolean;

/**
 * Event types for streaming updates
 */
export type StreamingEventType =
  | 'stream_start'
  | 'stream_chunk'
  | 'stream_complete'
  | 'stream_error'
  | 'draft_update';

/**
 * Streaming event payload
 */
export interface StreamingEvent {
  /** Type of streaming event */
  type: StreamingEventType;
  /** Associated chat ID */
  chatId: number | string;
  /** Message thread ID if applicable */
  messageThreadId?: number;
  /** Event payload data */
  data: StreamChunk | DraftBubbleState | Error;
  /** Event timestamp */
  timestamp: number;
}

/**
 * Events emitted by streaming handlers
 */
export interface StreamingHandlerEvents {
  'stream_start': (chatId: number | string, threadId?: number) => void;
  'stream_chunk': (chunk: StreamChunk, chatId: number | string, threadId?: number) => void;
  'stream_complete': (state: StreamState) => void;
  'stream_error': (error: Error, chatId: number | string) => void;
  'draft_update': (state: DraftBubbleState) => void;
}

// ============================================================================
// OutputParser Streaming Event Types
// ============================================================================

/**
 * Event emitted when a new stream starts in OutputParser
 */
export interface StreamingStartEvent {
  /** Timestamp when streaming started */
  timestamp: number;
}

/**
 * Event emitted for each text delta during streaming in OutputParser
 */
export interface StreamingDeltaEvent {
  /** The partial text chunk received */
  text: string;
  /** Total accumulated text so far */
  accumulatedText: string;
  /** Timestamp when this delta was received */
  timestamp: number;
}

/**
 * Event emitted when streaming completes in OutputParser
 */
export interface StreamingCompleteEvent {
  /** The final complete text */
  finalText: string;
  /** Total number of chunks received */
  totalChunks: number;
  /** Duration of the stream in milliseconds */
  durationMs: number;
  /** Timestamp when streaming completed */
  timestamp: number;
}
