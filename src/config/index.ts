import { config as loadDotenv } from 'dotenv';
import type {
  TelegramBotConfig,
  SessionManagerConfig,
  VoiceConfig,
  NotificationConfig,
  VerbosityConfig,
  FileUploadConfig,
  ExtendedTelegramBotConfig,
  VerbosityLevel,
  NotificationPreferences,
  ReportingConfig,
  LogLevel,
  StreamingConfig,
  StreamingMode,
  ThreadedModeConfig,
} from '../types/index.js';

// Load environment variables
loadDotenv();

/**
 * Get required environment variable or throw
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get optional environment variable with default
 */
function getEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

/**
 * Parse comma-separated list of numbers
 */
function parseNumberList(value: string): number[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const num = parseInt(s, 10);
      if (isNaN(num)) {
        throw new Error(`Invalid number in list: ${s}`);
      }
      return num;
    });
}

/**
 * Get SessionManager configuration from environment
 */
export function getSessionManagerConfig(): SessionManagerConfig {
  return {
    claudeCliPath: getEnv('CLAUDE_CLI_PATH', 'claude'),
    defaultWorkingDir: process.env['DEFAULT_WORKING_DIR'],
  };
}

/**
 * Get TelegramBot configuration from environment
 */
export function getTelegramBotConfig(): TelegramBotConfig {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const allowedUserIdsStr = requireEnv('ALLOWED_USER_IDS');
  const streamingConfig = buildStreamingConfig();
  const threadedModeConfig = buildThreadedModeConfig();
  return {
    token,
    streamingConfig,
    threadedModeConfig,
    allowedUserIds: parseNumberList(allowedUserIdsStr),
    sessionManagerConfig: getSessionManagerConfig(),
  };
}

/**
 * Get log level from environment
 */
export function getLogLevel(): LogLevel {
  const level = getEnv('LOG_LEVEL', 'info');
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  if (!validLevels.includes(level as LogLevel)) {
    return 'info';
  }
  return level as LogLevel;
}

/**
 * Parse boolean from environment variable
 */
function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse number from environment variable
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const num = parseFloat(value);
  return isNaN(num) ? defaultValue : num;
}

/**
 * Get voice configuration from environment
 */
export function getVoiceConfig(): VoiceConfig {
  return {
    enabled: parseBool(process.env['VOICE_ENABLED'], false),
    openaiApiKey: process.env['OPENAI_API_KEY'],
  };
}

/**
 * Get notification configuration from environment
 */
export function getNotificationConfig(): NotificationConfig {
  const defaultPrefs: NotificationPreferences = {
    completion: true,
    error: true,
    warning: true,
    progress: false,
  };

  const notificationDefaults = process.env['NOTIFICATION_DEFAULTS'];
  if (notificationDefaults) {
    try {
      const parsed = JSON.parse(notificationDefaults);
      return {
        defaults: {
          completion: parsed.completion ?? defaultPrefs.completion,
          error: parsed.error ?? defaultPrefs.error,
          warning: parsed.warning ?? defaultPrefs.warning,
          progress: parsed.progress ?? defaultPrefs.progress,
        },
      };
    } catch {
      // Invalid JSON, use defaults
    }
  }

  return { defaults: defaultPrefs };
}

/**
 * Get verbosity configuration from environment
 */
export function getVerbosityConfig(): VerbosityConfig {
  const level = getEnv('DEFAULT_VERBOSITY', 'normal');
  const validLevels: VerbosityLevel[] = ['minimal', 'normal', 'verbose'];
  const defaultLevel = validLevels.includes(level as VerbosityLevel)
    ? (level as VerbosityLevel)
    : 'normal';

  return { defaultLevel };
}

/**
 * Get file upload configuration from environment
 */
export function getFileUploadConfig(): FileUploadConfig {
  const defaultMimeTypes = [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ];

  const defaultExtensions = [
    '.txt', '.md', '.csv', '.json', '.pdf',
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.ts', '.js', '.py', '.java', '.go', '.rs',
    '.c', '.cpp', '.h', '.hpp', '.cs', '.rb',
    '.html', '.css', '.scss', '.xml', '.yaml', '.yml',
    '.sh', '.bash', '.zsh', '.sql', '.graphql',
  ];

  return {
    enabled: parseBool(process.env['FILE_UPLOAD_ENABLED'], false),
    maxFileSizeMB: parseNumber(process.env['MAX_FILE_SIZE_MB'], 10),
    supportedMimeTypes: defaultMimeTypes,
    allowedExtensions: defaultExtensions,
  };
}

/**
 * Get run reporting configuration from environment
 */
export function getReportingConfig(): ReportingConfig {
  return {
    enabled: parseBool(process.env['RUN_REPORTS_ENABLED'], true),
    autoSend: parseBool(process.env['RUN_REPORTS_AUTOSEND'], true),
    babysitterOnly: parseBool(process.env['RUN_REPORTS_BABYSITTER_ONLY'], true),
    maxRunsPerSession: parseNumber(process.env['RUN_REPORTS_MAX_RUNS'], 25),
    maxOutputChars: parseNumber(process.env['RUN_REPORTS_MAX_OUTPUT_CHARS'], 12000),
    maxEvents: parseNumber(process.env['RUN_REPORTS_MAX_EVENTS'], 200),
    maxToolInputChars: parseNumber(process.env['RUN_REPORTS_MAX_TOOL_INPUT_CHARS'], 2000),
    maxFileSizeMB: parseNumber(process.env['RUN_REPORTS_MAX_FILE_MB'], 45),
    previewDir: process.env['RUN_REPORTS_PREVIEW_DIR'],
  };
}

/**
 * Get extended TelegramBot configuration from environment
 */
export function getExtendedTelegramBotConfig(): ExtendedTelegramBotConfig {
  const baseConfig = getTelegramBotConfig();

  return {
    ...baseConfig,
    voiceConfig: getVoiceConfig(),
    notificationConfig: getNotificationConfig(),
    verbosityConfig: getVerbosityConfig(),
    fileUploadConfig: getFileUploadConfig(),
    reportingConfig: getReportingConfig(),
    logLevel: getLogLevel(),
  };
}

// ============================================================================
// Streaming Configuration
// ============================================================================

/**
 * Valid streaming modes
 */
const VALID_STREAMING_MODES: StreamingMode[] = ['partial', 'block', 'off'];

/**
 * Validate and parse streaming mode from environment variable
 */
function parseStreamingMode(value: string | undefined, defaultValue: StreamingMode): StreamingMode {
  if (!value) return defaultValue;
  const normalized = value.toLowerCase() as StreamingMode;
  if (VALID_STREAMING_MODES.includes(normalized)) {
    return normalized;
  }
  return defaultValue;
}

/**
 * Get whether streaming is enabled from environment
 */
export function getStreamingEnabled(): boolean {
  return parseBool(process.env['STREAMING_ENABLED'], true);
}

/**
 * Get streaming mode from environment
 */
export function getStreamingMode(): StreamingMode {
  return parseStreamingMode(process.env['STREAMING_MODE'], 'partial');
}

/**
 * Get streaming block size from environment
 */
export function getStreamingBlockSize(): number {
  return parseNumber(process.env['STREAMING_BLOCK_SIZE'], 50);
}

/**
 * Get streaming update interval in milliseconds from environment
 */
export function getStreamingUpdateInterval(): number {
  return parseNumber(process.env['STREAMING_UPDATE_INTERVAL_MS'], 200);
}

/**
 * Build StreamingConfig from environment variables
 */
export function buildStreamingConfig(): StreamingConfig {
  return {
    enabled: getStreamingEnabled(),
    mode: getStreamingMode(),
    blockSize: getStreamingBlockSize(),
    updateIntervalMs: getStreamingUpdateInterval(),
  };
}

// ============================================================================
// Threaded Mode Configuration
// ============================================================================

/**
 * Get whether threaded mode is enabled from environment
 * Default: false (threaded mode is opt-in)
 */
export function getThreadedModeEnabled(): boolean {
  return parseBool(process.env['THREADED_MODE_ENABLED'], false);
}

/**
 * Get whether auto-create topics is enabled from environment
 * Default: false (auto-create is opt-in)
 */
export function getThreadedAutoCreate(): boolean {
  return parseBool(process.env['THREADED_AUTO_CREATE'], false);
}

/**
 * Get default topic name prefix from environment
 */
export function getThreadedDefaultTopic(): string | undefined {
  const value = process.env['THREADED_DEFAULT_TOPIC'];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Build ThreadedModeConfig from environment variables
 */
export function buildThreadedModeConfig(): ThreadedModeConfig {
  return {
    enabled: getThreadedModeEnabled(),
    autoCreateTopics: getThreadedAutoCreate(),
    topicNamePrefix: getThreadedDefaultTopic(),
  };
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validation result for configuration
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate streaming configuration values
 */
export function validateStreamingConfig(config: StreamingConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate mode
  if (!VALID_STREAMING_MODES.includes(config.mode)) {
    errors.push(`Invalid streaming mode: ${config.mode}. Valid values: ${VALID_STREAMING_MODES.join(', ')}`);
  }

  // Validate block size
  if (config.blockSize < 1) {
    errors.push(`Streaming block size must be at least 1, got: ${config.blockSize}`);
  } else if (config.blockSize > 4096) {
    warnings.push(`Streaming block size ${config.blockSize} is very large, consider using a smaller value`);
  }

  // Validate update interval
  if (config.updateIntervalMs < 50) {
    errors.push(`Streaming update interval must be at least 50ms, got: ${config.updateIntervalMs}ms`);
  } else if (config.updateIntervalMs < 100) {
    warnings.push(`Streaming update interval ${config.updateIntervalMs}ms is very short, may cause rate limiting`);
  }

  // Warn if enabled but mode is 'off'
  if (config.enabled && config.mode === 'off') {
    warnings.push("Streaming is enabled but mode is 'off', streaming will not be active");
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate threaded mode configuration values
 */
export function validateThreadedModeConfig(config: ThreadedModeConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate topic name prefix if auto-create is enabled
  if (config.autoCreateTopics && !config.topicNamePrefix) {
    warnings.push('Auto-create topics is enabled but no topic name prefix is set');
  }

  // Validate topic name prefix length
  if (config.topicNamePrefix && config.topicNamePrefix.length > 100) {
    errors.push(`Topic name prefix too long: ${config.topicNamePrefix.length} chars (max 100)`);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate all streaming and threaded mode configuration
 */
export function validateAllConfig(): ConfigValidationResult {
  const streamingConfig = buildStreamingConfig();
  const threadedConfig = buildThreadedModeConfig();
  const streamingValidation = validateStreamingConfig(streamingConfig);
  const threadedValidation = validateThreadedModeConfig(threadedConfig);

  return {
    isValid: streamingValidation.isValid && threadedValidation.isValid,
    errors: [...streamingValidation.errors, ...threadedValidation.errors],
    warnings: [...streamingValidation.warnings, ...threadedValidation.warnings],
  };
}

// ============================================================================
// Configuration Constants (for reference)
// ============================================================================

/**
 * Environment variable names for streaming configuration
 */
export const STREAMING_CONFIG_ENV_KEYS = {
  STREAMING_MODE: 'STREAMING_MODE',
  STREAMING_ENABLED: 'STREAMING_ENABLED',
  STREAMING_BLOCK_SIZE: 'STREAMING_BLOCK_SIZE',
  STREAMING_UPDATE_INTERVAL_MS: 'STREAMING_UPDATE_INTERVAL_MS',
} as const;

/**
 * Environment variable names for threaded mode configuration
 */
export const THREADED_MODE_CONFIG_ENV_KEYS = {
  THREADED_MODE_ENABLED: 'THREADED_MODE_ENABLED',
  THREADED_AUTO_CREATE: 'THREADED_AUTO_CREATE',
  THREADED_DEFAULT_TOPIC: 'THREADED_DEFAULT_TOPIC',
} as const;

/**
 * Default values for streaming configuration
 */
export const STREAMING_CONFIG_DEFAULTS = {
  STREAMING_MODE: 'partial' as StreamingMode,
  STREAMING_ENABLED: true,
  STREAMING_BLOCK_SIZE: 50,
  STREAMING_UPDATE_INTERVAL_MS: 200,
} as const;

/**
 * Default values for threaded mode configuration
 */
export const THREADED_MODE_CONFIG_DEFAULTS = {
  THREADED_MODE_ENABLED: true,
  THREADED_AUTO_CREATE: false,
  THREADED_DEFAULT_TOPIC: '',
} as const;
