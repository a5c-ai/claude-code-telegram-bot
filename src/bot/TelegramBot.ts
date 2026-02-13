import { Telegraf, Context } from 'telegraf';
import type { Update, Message } from 'telegraf/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  TelegramBotConfig,
  ExtendedTelegramBotConfig,
  ParsedQuestion,
  PendingQuestionWithSession,
  Session,
  TelegramFormattedMessage,
  VerbosityLevel,
  NotificationType,
  NotificationPreferences,
  VoiceConfig,
  FileUploadConfig,
  StreamingConfig,
  StreamingMode,
  ThreadedModeConfig,
  StreamingTelegramBotConfig,
  SessionContext,
  ReportingConfig,
} from '../types/index.js';
import { SessionManager } from '../session/SessionManager.js';
import { OutputParser } from '../parser/OutputParser.js';
import { ClaudeSessionScanner, VoiceHandler, FileHandler } from '../utils/index.js';
import { NotificationManager } from '../notifications/index.js';
import { StreamingService, DraftMessageHandler } from '../streaming/index.js';
import { ThreadManager, TopicHandler } from '../threaded/index.js';
import { CommandRegistrationService } from './commands/index.js';
import { HistoricalRunImporter, ReportGenerator, RunTracker } from '../reporting/index.js';
import type { RunRecord, RunContext } from '../reporting/index.js';

type TextContext = Context<Update.MessageUpdate<Message.TextMessage>>;
type CallbackContext = Context<Update.CallbackQueryUpdate>;

// Bot commands that are handled by the Telegram bot itself (not forwarded to Claude)
const BOT_COMMANDS = new Set([
  'start', 'help', 'new', 'cd', 'list', 'switch', 'close', 'status', 'abort', 'kill', 'sessions', 'attach',
  'voice', 'notify', 'verbosity', 'upload', 'file', 'diff', 'escape',
  'log', 'pwd', 'git', 'tree', 'bookmark', 'context', 'cost',
  'report', 'reporthistory',
  'babysit', // Alias for /babysitter:call
  'streaming', 'threads', 'topic', 'threadsession', 'threadsessions', 'linksession', 'unlinksession' // Streaming and threaded mode commands
]);

// Default notification preferences
const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  completion: true,
  error: true,
  warning: true,
  progress: false,
};

/**
 * Telegram bot for remote Claude Code operation
 */
export class TelegramBot {
  private bot: Telegraf;
  private sessionManager: SessionManager;
  private outputParser: OutputParser;
  private sessionScanner: ClaudeSessionScanner;
  private allowedUsers: Set<number>;
  private userChatIds: Map<number, number> = new Map(); // userId -> chatId
  private pendingQuestions: Map<number, PendingQuestionWithSession> = new Map(); // chatId -> question with sessionId
  private awaitingCustomInput: Set<number> = new Set(); // chatIds awaiting custom input
  private outputUnsubscribers: Map<string, () => void> = new Map(); // sessionId -> unsubscribe function
  private errorUnsubscribers: Map<string, () => void> = new Map(); // sessionId -> error unsubscribe
  private closeUnsubscribers: Map<string, () => void> = new Map(); // sessionId -> close unsubscribe
  private lastThinkingMessageTime = 0; // Debounce thinking messages
  private static readonly THINKING_DEBOUNCE_MS = 5000; // 5 seconds debounce
  // Per-session question state to avoid race conditions across multiple users/sessions
  // Key: sessionId, Value: true if waiting for user response to a question
  private waitingForUserResponse: Map<string, boolean> = new Map();
  // Per-session suppressed messages buffer
  // Key: sessionId, Value: array of suppressed messages while waiting for response
  private suppressedMessages: Map<string, string[]> = new Map();

  // New feature state
  private voiceHandler: VoiceHandler | null = null;
  private fileHandler: FileHandler | null = null;
  private notificationManager: NotificationManager | null = null;
  private voiceConfig: VoiceConfig;
  private fileUploadConfig: FileUploadConfig;
  private userVoiceEnabled: Map<number, boolean> = new Map(); // userId -> voice enabled
  private userUploadEnabled: Map<number, boolean> = new Map(); // userId -> upload enabled
  private userVerbosityLevel: Map<number, VerbosityLevel> = new Map(); // userId -> verbosity
  private userNotificationPrefs: Map<number, NotificationPreferences> = new Map(); // userId -> notification prefs
  private defaultVerbosity: VerbosityLevel;
  private defaultNotificationPrefs: NotificationPreferences;
  private reportingConfig: ReportingConfig;
  private runTracker: RunTracker;
  private historicalRunImporter: HistoricalRunImporter;

  // Output history for /log command
  private outputHistory: string[] = [];
  private static readonly MAX_OUTPUT_HISTORY = 100; // Keep last 100 lines

  // Bookmarks for /bookmark command
  private userBookmarks: Map<number, Map<string, string>> = new Map(); // userId -> (name -> prompt)

  // Rate limiting and message queue (with thread support)
  private messageQueue: Array<{ chatId: number; message: string; timestamp: number; userId?: number; threadId?: number }> = [];
  private isProcessingQueue = false;
  private lastMessageTime: Map<number, number> = new Map(); // chatId -> timestamp
  private static readonly RATE_LIMIT_MS = 1000; // Minimum time between messages to same chat
  private static readonly MAX_QUEUE_SIZE = 50;

  // Input validation - security hardening (REM-005)
  private static readonly MAX_MESSAGE_LENGTH = 10240; // 10KB max input size

  // Message batching (with thread support)
  private messageBatchBuffer: Map<string, { messages: string[]; userId?: number; threadId?: number }> = new Map(); // `${chatId}:${threadId}` -> batch context
  private messageBatchTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly BATCH_DELAY_MS = 500; // Delay before sending batched messages

  // Context tracking for /context command
  private lastContextInfo: { tokens?: number; percentage?: number; timestamp?: Date } = {};

  // Cost tracking for /cost command
  private pendingCostCallback: ((response: string) => void) | null = null;

  // Group chat support - track which chat initiated the current conversation
  private activeChat: number | null = null; // The chat that should receive responses
  private botUsername: string | null = null; // Bot's username for mention detection

  // Streaming support (Bot API 9.3)
  private streamingService: StreamingService | null = null;
  private draftHandler: DraftMessageHandler | null = null;
  private streamingConfig: StreamingConfig;
  private userStreamingMode: Map<number, StreamingMode> = new Map(); // userId -> streaming mode

  // Threaded mode support (forum topics)
  private threadManager: ThreadManager | null = null;
  private topicHandler: TopicHandler | null = null;
  private threadedModeConfig: ThreadedModeConfig;
  private userThreadedMode: Map<number, boolean> = new Map(); // userId -> threaded mode enabled
  private userLastThreadId: Map<string, number> = new Map(); // `${chatId}:${userId}` -> last seen thread_id
  // Note: Session-to-thread mapping is now handled exclusively by ThreadManager
  // The private sessionThreadMapping property has been removed in favor of threadManager.getThreadForSession()

  // Track which session is currently producing output (for correct thread routing)
  // This is set before parsing output and used in forwardTextToUsers
  private currentOutputSessionId: string | null = null;

  // Command registration service for Telegram command menus
  private commandRegistrationService: CommandRegistrationService | null = null;

  constructor(config: TelegramBotConfig | ExtendedTelegramBotConfig | StreamingTelegramBotConfig) {
    this.bot = new Telegraf(config.token);
    this.sessionManager = new SessionManager(config.sessionManagerConfig);
    this.outputParser = new OutputParser();
    this.sessionScanner = new ClaudeSessionScanner();
    this.allowedUsers = new Set(config.allowedUserIds);

    // Initialize new feature configs
    const extConfig = config as ExtendedTelegramBotConfig;
    this.voiceConfig = extConfig.voiceConfig || { enabled: false };
    this.fileUploadConfig = extConfig.fileUploadConfig || {
      enabled: false,
      maxFileSizeMB: 10,
      supportedMimeTypes: [],
      allowedExtensions: [],
    };
    this.reportingConfig = extConfig.reportingConfig || {
      enabled: true,
      autoSend: true,
      babysitterOnly: true,
      maxRunsPerSession: 25,
      maxOutputChars: 12000,
      maxEvents: 200,
      maxToolInputChars: 2000,
      maxFileSizeMB: 45,
      previewDir: undefined,
    };
    this.runTracker = new RunTracker(this.reportingConfig);
    this.historicalRunImporter = new HistoricalRunImporter(this.reportingConfig);
    if (this.reportingConfig.enabled) {
      this.outputParser.setStreamingEnabled(true);
    }
    this.defaultVerbosity = extConfig.verbosityConfig?.defaultLevel || 'normal';
    this.defaultNotificationPrefs = extConfig.notificationConfig?.defaults || DEFAULT_NOTIFICATION_PREFS;

    // Initialize voice handler if configured
    if (this.voiceConfig.enabled && this.voiceConfig.openaiApiKey) {
      this.voiceHandler = new VoiceHandler(this.voiceConfig);
    }

    // Initialize file handler if configured
    if (this.fileUploadConfig.enabled) {
      this.fileHandler = new FileHandler(this.fileUploadConfig);
    }

    // Initialize notification manager
    this.notificationManager = new NotificationManager({
      defaults: this.defaultNotificationPrefs,
    });

    // Initialize streaming config (Bot API 9.3)
    const streamConfig = config as StreamingTelegramBotConfig;
    this.streamingConfig = streamConfig.streamingConfig || {
      mode: 'off',
      blockSize: 100,
      updateIntervalMs: 500,
      enabled: false,
    };

    // Initialize threaded mode config
    this.threadedModeConfig = streamConfig.threadedModeConfig || {
      enabled: false,
      autoCreateTopics: false,
      topicNamePrefix: 'Chat',
    };

    // Initialize streaming service if enabled
    if (this.streamingConfig.enabled) {
      this.streamingService = new StreamingService(config.token, this.streamingConfig);
      this.draftHandler = new DraftMessageHandler(this.streamingService, {
        streamingConfig: this.streamingConfig,
      });
      this.setupStreamingEventHandlers();
    }

    // Initialize thread manager if enabled
    if (this.threadedModeConfig.enabled) {
      this.threadManager = new ThreadManager(this.threadedModeConfig, config.token);
      this.topicHandler = new TopicHandler(config.token);
      this.setupThreadEventHandlers();
    }

    // Initialize command registration service
    this.commandRegistrationService = new CommandRegistrationService(this.bot);

    this.setupMiddleware();
    this.setupCommands();
    this.setupCallbackHandlers();
    this.setupMessageHandlers();
    this.setupOutputForwarding();

    if (this.reportingConfig.enabled) {
      this.runTracker.on('run_complete', (run) => {
        const shouldSend = this.reportingConfig.autoSend &&
          (!this.reportingConfig.babysitterOnly || run.runType === 'babysitter');
        if (shouldSend) {
          this.sendRunReport(run).catch((error) => {
            console.error('[Report] Failed to auto-send run report:', error);
          });
        }
      });
    }
  }

  /**
   * Set up streaming event handlers for error handling
   */
  private setupStreamingEventHandlers(): void {
    if (!this.streamingService) return;

    this.streamingService.on('error', (error: Error, chatId: number | string) => {
      console.error(`[Streaming] Error for chat ${chatId}:`, error.message);
    });

    this.streamingService.on('rate_limited', (retryAfter: number, chatId: number | string) => {
      console.warn(`[Streaming] Rate limited for chat ${chatId}, retry after ${retryAfter}s`);
    });

    if (this.draftHandler) {
      this.draftHandler.on('error', (error: Error, chatId: number | string) => {
        console.error(`[DraftHandler] Error for chat ${chatId}:`, error.message);
      });
    }
  }

  /**
   * Set up thread manager event handlers
   */
  private setupThreadEventHandlers(): void {
    if (!this.threadManager) return;

    this.threadManager.on('error', (error: Error, chatId: number | string) => {
      console.error(`[ThreadManager] Error for chat ${chatId}:`, error.message);
    });

    this.threadManager.on('topic_created', (chatId: number | string, topic: { name: string; message_thread_id: number }) => {
      console.log(`[ThreadManager] Topic created in chat ${chatId}: ${topic.name} (thread_id: ${topic.message_thread_id})`);
    });
  }

  /**
   * Set up authorization middleware
   */
  private setupMiddleware(): void {
    // Authorization middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const chatType = ctx.chat?.type;
      const isGroup = chatType === 'group' || chatType === 'supergroup';

      if (!userId || !this.isUserAuthorized(userId)) {
        // In groups, silently ignore unauthorized users to avoid spam
        if (isGroup) {
          return;
        }
        // In private chats, tell the user they're not authorized
        await ctx.reply('Unauthorized. Your user ID is not in the allowed list.');
        return;
      }

      // Store chat ID for this user
      if (ctx.chat) {
        const wasNew = !this.userChatIds.has(userId);
        this.userChatIds.set(userId, ctx.chat.id);
        if (wasNew) {
          console.log(`[Auth] User ${userId} connected with chat ID ${ctx.chat.id} (${chatType})`);
        }
      }

      await next();
    });

    // Error handling middleware
    this.bot.catch((err, ctx) => {
      console.error(`Error for ${ctx.updateType}:`, err);
      ctx.reply('An error occurred. Please try again.').catch(() => {});
    });
  }

  /**
   * Set up command handlers
   */
  private setupCommands(): void {
    // /start - Welcome message
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🤖 Welcome to Claude Code Bot!\n\n' +
          'Control Claude Code CLI remotely from Telegram.\n\n' +
          'Session Commands:\n' +
          '/new <name> [dir] [--no-topic] - Create new session\n' +
          '/list - List all sessions\n' +
          '/switch <id> - Switch to session\n' +
          '/status - Current session info\n' +
          '/help - Full command list\n\n' +
          'Files & Git:\n' +
          '/file <path> - Get file contents\n' +
          '/diff [path] - Show git diff\n' +
          '/git - Quick git operations\n' +
          '/tree - Directory tree view\n\n' +
          'Utilities:\n' +
          '/pwd - Working directory\n' +
          '/log - Output history\n' +
          '/bookmark - Save/recall prompts\n' +
          '/context - Context usage\n' +
          '/cost - Session costs\n' +
          '/report - Latest run report\n' +
          '/reporthistory - Report from already-completed runs\n\n' +
          'Send any text to interact with the active Claude session.\n\n' +
          '═══════════════════════════════\n' +
          '🧙 100% Built using Babysitter\n' +
          '      by a5c.ai - https://a5c.ai\n' +
          '═══════════════════════════════'
      );
    });

    // /help - Show help
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        'Claude Code Bot Commands\n\n' +
          '⭐ Recommended:\n' +
          '/babysit [task] - Start Babysitter for complex workflows\n\n' +
          'Session Management:\n' +
          '/new <name> [dir] [--no-topic] - Create a new session (auto-creates topic in forums)\n' +
          '/sessions - List existing Claude sessions on system\n' +
          '/attach <id> [dir] - Attach to existing session\n' +
          '/list - List active Telegram sessions\n' +
          '/switch <id> - Switch to a different session\n' +
          '/close <id> - Close and terminate a session\n' +
          '/status - Show current session details\n' +
          '/cd <path> - Change working directory (non-threaded mode only)\n\n' +
          'Control:\n' +
          '/abort - Abort current operation (Ctrl+C)\n' +
          '/escape - Send ESC to interrupt and allow new prompt\n' +
          '/kill - Force kill current process\n\n' +
          'Files & Git:\n' +
          '/file <path> [--raw] - Get file contents or directory listing\n' +
          '/diff [path] - Show git diff (use --staged for staged changes)\n' +
          '/git [status|branch|log|stash|remote] - Quick git operations\n' +
          '/tree [depth] [path] - Directory tree view\n\n' +
          'Utilities:\n' +
          '/pwd - Show working directory\n' +
          '/log [n] - View recent output history\n' +
          '/bookmark - Save and recall prompts\n' +
          '/context - Show context usage\n' +
          '/cost - Get session cost information\n' +
          '/report [runId] - Get latest run report\n' +
          '/reporthistory [project] [--index N] - Report from completed runs\n\n' +
          'Features:\n' +
          '/voice [on|off] - Toggle voice transcription\n' +
          '/upload [on|off] - Toggle file upload\n' +
          '/verbosity [level] - Set output verbosity (minimal|normal|verbose)\n' +
          '/notify [type] [on|off] - Configure notifications\n\n' +
          'Threaded Mode (each thread has isolated sessions):\n' +
          '/threads [on|off] - Toggle threaded mode\n' +
          '/topic <create|list|use|check> - Manage forum topics\n' +
          '/threadsession - Show session bound to current thread\n' +
          '/threadsessions - List all sessions and their thread bindings\n' +
          '/linksession <id> - Link a session to current thread\n' +
          '/unlinksession - Unlink session from current thread\n\n' +
          'Note: In threaded mode, use /new <name> <dir> to set working directory.\n' +
          'When Claude asks questions, use the inline buttons or type a custom response.\n' +
          'You can send voice messages and upload files when enabled.\n\n' +
          '═══════════════════════════════\n' +
          '🧙 100% Built using Babysitter\n' +
          '      by a5c.ai - https://a5c.ai'
      );
    });

    // /new - Create new session
    this.bot.command('new', async (ctx) => {
      try {
        // Parse command: /new <name> [workingDir] [--no-topic]
        // Working dir is optional and can contain spaces if quoted
        const fullText = ctx.message.text;
        const withoutCommand = fullText.replace(/^\/new\s*/, '').trim();
        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;

        // Parse --no-topic flag
        const noTopicFlag = withoutCommand.includes('--no-topic');
        const cleanedArgs = withoutCommand.replace('--no-topic', '').trim();

        // Extract thread_id from the command message for thread support
        const messageThreadId = this.extractThreadId(ctx.message);

        let name: string;
        let workingDir: string | undefined;

        if (!cleanedArgs) {
          // No args: /new
          name = `session-${Date.now()}`;
          workingDir = undefined;
        } else {
          // Split by spaces, first arg is name
          const parts = cleanedArgs.split(/\s+/);
          name = parts[0];
          // Rest is working dir (join back in case path has spaces)
          workingDir = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
        }

        // Only use workingDir if it's actually provided (not empty string)
        const effectiveWorkingDir = workingDir && workingDir.trim() ? workingDir.trim() : undefined;

        // Check if session with same name exists - close it first
        const existingSessions = this.sessionManager.listSessions();
        const existingSession = existingSessions.find(s => s.name === name);
        if (existingSession) {
          // Unsubscribe from old session output
          this.unsubscribeFromSession(existingSession.id);
          await this.sessionManager.closeSession(existingSession.id);
          await this.replyWithThreadSupport(ctx, `Closed existing session "${name}"`, messageThreadId);
        }

        const session = await this.sessionManager.createSession(name, effectiveWorkingDir);

        // Reset waiting state for new session (per-session tracking)
        this.waitingForUserResponse.delete(session.id);
        this.suppressedMessages.delete(session.id);

        // Subscribe to session output
        this.subscribeToSessionOutput(session.id);

        // If threaded mode enabled and we have a threadId, bind session to this thread
        // Session-thread binding is handled exclusively by ThreadManager
        if (this.threadManager && this.isThreadedModeEnabledForUser(userId ?? 0) && messageThreadId !== undefined) {
          const sessionContext: SessionContext = {
            chatId,
            threadId: messageThreadId,
            userId,
          };
          this.sessionManager.setActiveSessionForContext(sessionContext, session.id);
          this.threadManager.setSessionForThread(chatId, messageThreadId, session.id);
          console.log(`[Threads] Bound new session ${session.id.substring(0, 8)}... to thread ${messageThreadId}`);
        }

        // Auto-create topic in forum groups (if not disabled and handlers available)
        console.log(`[/new] Checking auto-topic: topicHandler=${!!this.topicHandler}, threadManager=${!!this.threadManager}, noTopicFlag=${noTopicFlag}, messageThreadId=${messageThreadId}`);
        if (this.topicHandler && this.threadManager && !noTopicFlag && messageThreadId === undefined) {
          try {
            // Check if this is a forum group
            const isForumEnabled = await this.topicHandler.checkForumEnabled(chatId);
            console.log(`[/new] Forum enabled check: ${isForumEnabled}`);
            if (isForumEnabled) {
              // Create topic for this session
              const topicName = `Session: ${session.name || session.id.slice(0, 8)}`;
              console.log(`[/new] Creating topic: "${topicName}" for session ${session.id}`);
              const topic = await this.topicHandler.createTopic(chatId, { name: topicName });
              console.log(`[/new] Topic created: ${JSON.stringify(topic)}`);

              if (topic?.message_thread_id) {
                console.log(`[/new] Binding session ${session.id} to thread ${topic.message_thread_id}`);
                // Bind session to the new topic
                this.threadManager.setSessionForThread(chatId, topic.message_thread_id, session.id);

                // Verify the binding was successful
                const verifySession = this.threadManager.getSessionForThread(chatId, topic.message_thread_id);
                const verifyThread = this.threadManager.getThreadForSession(session.id);
                console.log(`[/new] VERIFY after binding: getSessionForThread=${verifySession}, getThreadForSession=${JSON.stringify(verifyThread)}`);

                // Update session context for the new topic
                const sessionContext: SessionContext = {
                  chatId,
                  threadId: topic.message_thread_id,
                  userId,
                };
                this.sessionManager.setActiveSessionForContext(sessionContext, session.id);

                // Send confirmation to the NEW topic (not main chat)
                await this.bot.telegram.sendMessage(
                  chatId,
                  `Session created and bound to this topic!\n\n` +
                    `ID: \`${session.id}\`\n` +
                    `Name: ${session.name}\n` +
                    `Directory: ${session.workingDir}\n` +
                    `Status: ${session.status}`,
                  { message_thread_id: topic.message_thread_id, parse_mode: 'Markdown' }
                );
                console.log(`[AutoTopic] SUCCESS: Created topic "${topicName}" (ID: ${topic.message_thread_id}) for session ${session.id}`);

                // Update command menu to show session interaction commands
                if (this.commandRegistrationService) {
                  await this.commandRegistrationService.updateCommandsForChat(chatId, true, true);
                }
                return; // Skip the regular reply since we sent to the topic
              } else {
                console.log(`[/new] Topic created but no message_thread_id returned`);
              }
            }
          } catch (error) {
            console.warn(`[AutoTopic] Failed to create topic for session: ${error}`);
            // Fall through to normal behavior
          }
        } else {
          console.log(`[/new] Skipping auto-topic creation`);
        }

        await this.replyWithThreadSupport(ctx,
          `Session created!\n\n` +
            `ID: \`${session.id}\`\n` +
            `Name: ${session.name}\n` +
            `Directory: ${session.workingDir}\n` +
            `Status: ${session.status}`,
          messageThreadId,
          'Markdown'
        );

        // Update command menu to show session interaction commands
        if (this.commandRegistrationService) {
          const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
          await this.commandRegistrationService.updateCommandsForChat(chatId, true, isGroup);
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Unknown error';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error creating session: ${messageText}`, messageThreadId);
      }
    });

    // /cd - Change directory for current session (disabled in threaded mode)
    this.bot.command('cd', async (ctx) => {
      try {
        const userId = ctx.from?.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        // Check if threaded mode is enabled - /cd is not allowed in threaded mode
        // because each thread has its own isolated session
        if (this.threadedModeConfig.enabled && this.threadManager) {
          await this.replyWithThreadSupport(ctx,
            '⚠️ The /cd command is not available in threaded mode.\n\n' +
            'In threaded mode, each thread has its own isolated session.\n' +
            'To create a session with a specific working directory:\n\n' +
            '  /new <name> <directory>\n\n' +
            'Example: /new myproject C:\\work\\myproject',
            messageThreadId
          );
          return;
        }

        const newDir = ctx.message.text.split(' ').slice(1).join(' ');
        if (!newDir) {
          await ctx.reply('Usage: /cd <path>');
          return;
        }

        const currentSession = this.sessionManager.getActiveSession();
        if (!currentSession) {
          await ctx.reply('No active session. Use /new to create one.');
          return;
        }

        // Change directory (this restarts the process)
        const updatedSession = await this.sessionManager.changeDirectory(currentSession.id, newDir);

        // Re-subscribe to output
        this.subscribeToSessionOutput(updatedSession.id);

        await ctx.reply(
          `Directory changed!\n\n` +
            `Session: ${updatedSession.name}\n` +
            `New directory: ${updatedSession.workingDir}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`Error changing directory: ${message}`);
      }
    });

    // /list - List sessions
    this.bot.command('list', async (ctx) => {
      const sessions = this.sessionManager.listSessions();
      const activeSession = this.sessionManager.getActiveSession();

      if (sessions.length === 0) {
        await ctx.reply('No active sessions. Use /new to create one.');
        return;
      }

      // Get thread mappings if threaded mode is enabled
      let threadMappings: Map<string, { chatId: number | string; threadId: number }> | null = null;
      if (this.threadManager && this.threadedModeConfig.enabled) {
        threadMappings = this.threadManager.getAllSessionMappings();
      }

      let message = 'Sessions:\n\n';
      for (const session of sessions) {
        const isActive = activeSession?.id === session.id;
        const marker = isActive ? '✓ ' : '  ';
        message += `${marker}\`${session.id}\`\n`;
        message += `   Name: ${session.name}\n`;
        message += `   Status: ${session.status}\n`;
        message += `   Dir: ${session.workingDir}\n`;

        // Show thread binding if threaded mode is enabled
        if (threadMappings) {
          const mapping = threadMappings.get(session.id);
          if (mapping) {
            message += `   Thread: ${mapping.threadId} (Chat: ${mapping.chatId})\n`;
          } else {
            message += `   Thread: (not bound)\n`;
          }
        }

        message += '\n';
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // /switch - Switch session
    this.bot.command('switch', async (ctx) => {
      try {
        const sessionId = ctx.message.text.split(' ')[1];
        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        if (!sessionId) {
          await this.replyWithThreadSupport(ctx, 'Usage: /switch <sessionId>', messageThreadId);
          return;
        }

        const session = this.sessionManager.switchSession(sessionId);

        // If threaded mode enabled and we have a threadId, bind session to this thread
        // Session-thread binding is handled exclusively by ThreadManager
        if (this.threadManager && this.isThreadedModeEnabledForUser(userId ?? 0) && messageThreadId !== undefined) {
          const sessionContext: SessionContext = {
            chatId,
            threadId: messageThreadId,
            userId,
          };
          this.sessionManager.setActiveSessionForContext(sessionContext, session.id);
          this.threadManager.setSessionForThread(chatId, messageThreadId, session.id);
          console.log(`[Threads] Bound switched session ${session.id.substring(0, 8)}... to thread ${messageThreadId}`);
        }

        await this.replyWithThreadSupport(ctx, `Switched to session: ${session.name} (\`${session.id}\`)`, messageThreadId, 'Markdown');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Session not found';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /close - Close session
    this.bot.command('close', async (ctx) => {
      try {
        const sessionId = ctx.message.text.split(' ')[1];
        if (!sessionId) {
          await ctx.reply('Usage: /close <sessionId>');
          return;
        }

        await this.sessionManager.closeSession(sessionId);
        await ctx.reply(`Session \`${sessionId}\` closed.`, { parse_mode: 'Markdown' });

        // Update command menu if no active sessions remain
        if (this.commandRegistrationService) {
          const remainingSessions = this.sessionManager.listSessions();
          const hasActiveSessions = remainingSessions.length > 0;
          const chatId = ctx.chat.id;
          const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
          await this.commandRegistrationService.updateCommandsForChat(chatId, hasActiveSessions, isGroup);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Session not found';
        await ctx.reply(`Error: ${message}`);
      }
    });

    // /status - Current session status
    this.bot.command('status', async (ctx) => {
      const chatId = ctx.chat?.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      let session = null;
      let sessionSource = 'global';

      // Check for thread-bound session first if threadManager exists
      if (this.threadManager && chatId && messageThreadId !== undefined) {
        const threadSessionId = this.threadManager.getSessionForThread(chatId, messageThreadId);
        if (threadSessionId) {
          session = this.sessionManager.getSession(threadSessionId);
          if (session) {
            sessionSource = 'thread-bound';
          }
        }
      }

      // Fall back to global active session
      if (!session) {
        session = this.sessionManager.getActiveSession();
        sessionSource = 'global';
      }

      if (!session) {
        await this.replyWithThreadSupport(ctx, 'No active session. Use /new to create one.', messageThreadId);
        return;
      }

      const sessionTypeInfo = sessionSource === 'thread-bound'
        ? `(Thread-bound to thread ${messageThreadId})`
        : '(Global active session)';

      await this.replyWithThreadSupport(ctx,
        `Current Session ${sessionTypeInfo}:\n\n` +
          `ID: \`${session.id}\`\n` +
          `Name: ${session.name}\n` +
          `Status: ${session.status}\n` +
          `Directory: ${session.workingDir}\n` +
          `Created: ${session.createdAt.toISOString()}\n` +
          `Last Activity: ${session.lastActivity.toISOString()}`,
        messageThreadId,
        'Markdown'
      );
    });

    // /abort - Abort current operation (sends Ctrl+C equivalent)
    this.bot.command('abort', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        // Resolve session based on thread context
        const { session, sessionId, source } = this.resolveSessionForThread(chatId, messageThreadId);

        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx,
            'No active session. Use /new to create one.',
            messageThreadId
          );
          return;
        }

        // Send Ctrl+C to the resolved session
        this.sessionManager.sendToSession(sessionId, '\x03');
        const sourceInfo = source === 'thread-bound' ? ' (thread-bound)' : '';
        await this.replyWithThreadSupport(ctx,
          `Abort signal sent to session${sourceInfo}.`,
          messageThreadId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No active session';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /kill - Force kill the current Claude process (hard stop)
    this.bot.command('kill', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        // Resolve session based on thread context
        const { session, sessionId, source } = this.resolveSessionForThread(chatId, messageThreadId);

        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx,
            'No active session to kill.',
            messageThreadId
          );
          return;
        }

        // Kill the process forcefully
        this.sessionManager.killSessionProcess(sessionId);
        const sourceInfo = source === 'thread-bound' ? ' (thread-bound)' : '';
        await this.replyWithThreadSupport(ctx,
          `🔪 Killed! Claude/Babysitter process terminated${sourceInfo}.`,
          messageThreadId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to kill process';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /escape - Send ESC key to abort current activity and allow new prompt
    this.bot.command('escape', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        // Resolve session based on thread context
        const { session, sessionId, source } = this.resolveSessionForThread(chatId, messageThreadId);

        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx,
            'No active session. Use /new to create one.',
            messageThreadId
          );
          return;
        }

        // Send ESC character (0x1B) to the resolved session
        this.sessionManager.sendToSession(sessionId, '\x1B');
        const sourceInfo = source === 'thread-bound' ? ' (thread-bound)' : '';
        await this.replyWithThreadSupport(ctx,
          `⎋ Escape sent${sourceInfo}. You can now send a new prompt.`,
          messageThreadId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No active session';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /sessions - List existing Claude sessions on the system
    this.bot.command('sessions', async (ctx) => {
      try {
        const recentSessions = this.sessionScanner.getRecentSessions(10);

        if (recentSessions.length === 0) {
          await ctx.reply('No recent Claude sessions found on this system.');
          return;
        }

        let message = '🗂️ *Recent Claude Sessions*\n\n';
        message += '_Use /attach <session-id> to connect_\n\n';

        for (const session of recentSessions) {
          message += this.sessionScanner.formatSession(session) + '\n\n';
        }

        await ctx.reply(message, { parse_mode: 'Markdown' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list sessions';
        await ctx.reply(`Error: ${message}`);
      }
    });

    // /attach - Attach to an existing Claude session
    this.bot.command('attach', async (ctx) => {
      try {
        const args = ctx.message.text.split(' ').slice(1);
        const chatId = ctx.chat.id;
        const userId = ctx.from?.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        if (args.length === 0) {
          await this.replyWithThreadSupport(ctx,
            'Usage: /attach <session-id> [working-dir]\n\n' +
            'Use /sessions to see available sessions.\n' +
            'You can use partial session IDs (first 8 characters).',
            messageThreadId
          );
          return;
        }

        const partialId = args[0];
        const workingDir = args.slice(1).join(' ') || undefined;

        // Find matching session
        const recentSessions = this.sessionScanner.getRecentSessions(100);
        const matchingSession = recentSessions.find(s =>
          s.sessionId.startsWith(partialId) || s.sessionId === partialId
        );

        if (!matchingSession) {
          await this.replyWithThreadSupport(ctx,
            `No session found matching "${partialId}". Use /sessions to see available sessions.`,
            messageThreadId
          );
          return;
        }

        // Use the session's project directory if no working dir specified
        const effectiveWorkingDir = workingDir || matchingSession.project;

        // Attach to the session
        const session = await this.sessionManager.attachToSession(
          matchingSession.projectName,
          matchingSession.sessionId,
          effectiveWorkingDir
        );

        // Reset waiting state for attached session (per-session tracking)
        this.waitingForUserResponse.delete(session.id);
        this.suppressedMessages.delete(session.id);

        // Subscribe to session output
        this.subscribeToSessionOutput(session.id);

        // If threaded mode enabled and we have a threadId, bind session to this thread
        // Session-thread binding is handled exclusively by ThreadManager
        if (this.threadManager && this.isThreadedModeEnabledForUser(userId ?? 0) && messageThreadId !== undefined) {
          const sessionContext: SessionContext = {
            chatId,
            threadId: messageThreadId,
            userId,
          };
          this.sessionManager.setActiveSessionForContext(sessionContext, session.id);
          this.threadManager.setSessionForThread(chatId, messageThreadId, session.id);
          console.log(`[Threads] Bound attached session ${session.id.substring(0, 8)}... to thread ${messageThreadId}`);
        }

        await this.replyWithThreadSupport(ctx,
          `Attached to existing session!\n\n` +
          `Session ID: \`${matchingSession.sessionId.substring(0, 8)}...\`\n` +
          `Project: ${matchingSession.projectName}\n` +
          `Directory: ${effectiveWorkingDir}\n\n` +
          `Send a message to continue this session.`,
          messageThreadId,
          'Markdown'
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Failed to attach';
        const messageThreadId = this.extractThreadId(ctx.message);
        await this.replyWithThreadSupport(ctx, `Error: ${messageText}`, messageThreadId);
      }
    });

    // /voice - Toggle voice message transcription
    this.bot.command('voice', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.voiceHandler) {
        await ctx.reply(
          'Voice transcription is not configured.\n' +
          'Set VOICE_ENABLED=true and OPENAI_API_KEY in your .env file.'
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      const arg = args[0]?.toLowerCase();

      if (arg === 'on') {
        this.userVoiceEnabled.set(userId, true);
        await ctx.reply('Voice transcription enabled. Send me a voice message!');
      } else if (arg === 'off') {
        this.userVoiceEnabled.set(userId, false);
        await ctx.reply('Voice transcription disabled.');
      } else {
        const currentState = this.userVoiceEnabled.get(userId) ?? this.voiceConfig.enabled;
        await ctx.reply(
          `Voice transcription: ${currentState ? 'ON' : 'OFF'}\n\n` +
          'Usage: /voice [on|off]'
        );
      }
    });

    // /notify - Configure notification preferences
    this.bot.command('notify', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const notificationType = args[0]?.toLowerCase() as NotificationType | 'all' | undefined;
      const action = args[1]?.toLowerCase();

      // Get or initialize user prefs
      let prefs = this.userNotificationPrefs.get(userId);
      if (!prefs) {
        prefs = { ...this.defaultNotificationPrefs };
        this.userNotificationPrefs.set(userId, prefs);
      }

      if (!notificationType) {
        // Show current settings
        await ctx.reply(
          'Notification Settings:\n\n' +
          `completion: ${prefs.completion ? 'ON' : 'OFF'}\n` +
          `error: ${prefs.error ? 'ON' : 'OFF'}\n` +
          `warning: ${prefs.warning ? 'ON' : 'OFF'}\n` +
          `progress: ${prefs.progress ? 'ON' : 'OFF'}\n\n` +
          'Usage: /notify <type> [on|off]\n' +
          'Types: completion, error, warning, progress, all'
        );
        return;
      }

      if (action !== 'on' && action !== 'off') {
        await ctx.reply('Usage: /notify <type> [on|off]');
        return;
      }

      const enabled = action === 'on';

      if (notificationType === 'all') {
        prefs.completion = enabled;
        prefs.error = enabled;
        prefs.warning = enabled;
        prefs.progress = enabled;
        await ctx.reply(`All notifications ${enabled ? 'enabled' : 'disabled'}.`);
      } else if (['completion', 'error', 'warning', 'progress'].includes(notificationType)) {
        prefs[notificationType as NotificationType] = enabled;
        await ctx.reply(`${notificationType} notifications ${enabled ? 'enabled' : 'disabled'}.`);
      } else {
        await ctx.reply('Invalid notification type. Use: completion, error, warning, progress, or all');
      }
    });

    // /verbosity - Set output verbosity level
    this.bot.command('verbosity', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const level = args[0]?.toLowerCase() as VerbosityLevel | undefined;

      if (!level) {
        const currentLevel = this.userVerbosityLevel.get(userId) ?? this.defaultVerbosity;
        await ctx.reply(
          `Current verbosity: ${currentLevel}\n\n` +
          'Levels:\n' +
          '  minimal - Questions only\n' +
          '  normal - Questions + final results\n' +
          '  verbose - All output including tool calls\n\n' +
          'Usage: /verbosity [minimal|normal|verbose]'
        );
        return;
      }

      if (!['minimal', 'normal', 'verbose'].includes(level)) {
        await ctx.reply('Invalid level. Use: minimal, normal, or verbose');
        return;
      }

      this.userVerbosityLevel.set(userId, level);
      await ctx.reply(`Verbosity set to: ${level}`);
    });

    // /upload - Toggle file upload support
    this.bot.command('upload', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      if (!this.fileUploadConfig.enabled) {
        await ctx.reply(
          'File upload is not configured.\n' +
          'Set FILE_UPLOAD_ENABLED=true in your .env file.'
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      const arg = args[0]?.toLowerCase();

      if (arg === 'on') {
        this.userUploadEnabled.set(userId, true);
        await ctx.reply(
          'File upload enabled.\n\n' +
          `Max file size: ${this.fileUploadConfig.maxFileSizeMB}MB\n` +
          'Send me a document or image!'
        );
      } else if (arg === 'off') {
        this.userUploadEnabled.set(userId, false);
        await ctx.reply('File upload disabled.');
      } else {
        const currentState = this.userUploadEnabled.get(userId) ?? this.fileUploadConfig.enabled;
        await ctx.reply(
          `File upload: ${currentState ? 'ON' : 'OFF'}\n` +
          `Max size: ${this.fileUploadConfig.maxFileSizeMB}MB\n\n` +
          'Usage: /upload [on|off]'
        );
      }
    });

    // /file - Request a file from working directory
    this.bot.command('file', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      if (args.length === 0) {
        await this.replyWithThreadSupport(ctx,
          'Request a file from the session working directory.\n\n' +
          'Usage:\n' +
          '  /file <path> - Send as formatted text\n' +
          '  /file <path> --raw - Send as file attachment\n\n' +
          'Examples:\n' +
          '  /file src/index.ts\n' +
          '  /file package.json --raw',
          messageThreadId
        );
        return;
      }

      const sendAsFile = args.includes('--raw');
      const filePath = args.filter(a => a !== '--raw').join(' ');

      try {
        // Resolve the path relative to working directory
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(session.workingDir, filePath);

        // Security check - ensure the path is within the working directory
        const resolvedPath = path.resolve(fullPath);
        const resolvedWorkingDir = path.resolve(session.workingDir);
        if (!resolvedPath.startsWith(resolvedWorkingDir)) {
          await ctx.reply('Error: Cannot access files outside the session working directory.');
          return;
        }

        // Check if file exists
        if (!fs.existsSync(resolvedPath)) {
          await ctx.reply(`File not found: ${filePath}`);
          return;
        }

        const stats = fs.statSync(resolvedPath);
        if (stats.isDirectory()) {
          // List directory contents
          const files = fs.readdirSync(resolvedPath);
          const listing = files.map(f => {
            const fPath = path.join(resolvedPath, f);
            const fStats = fs.statSync(fPath);
            return fStats.isDirectory() ? `📁 ${f}/` : `📄 ${f}`;
          }).join('\n');
          await ctx.reply(`Directory: ${filePath}\n\n${listing || '(empty)'}`);
          return;
        }

        // Check file size
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (stats.size > maxSize) {
          await ctx.reply(`File too large (${(stats.size / 1024 / 1024).toFixed(2)}MB). Max: 10MB`);
          return;
        }

        if (sendAsFile) {
          // Send as file attachment
          await ctx.replyWithDocument({
            source: resolvedPath,
            filename: path.basename(filePath)
          });
        } else {
          // Send as formatted text
          const content = fs.readFileSync(resolvedPath, 'utf-8');
          const ext = path.extname(filePath).slice(1) || 'txt';

          // Truncate if too long for Telegram
          const maxLength = 4000;
          const truncated = content.length > maxLength;
          const displayContent = truncated
            ? content.slice(0, maxLength) + '\n...(truncated)'
            : content;

          const message = `📄 \`${filePath}\`\n\n\`\`\`${ext}\n${displayContent}\n\`\`\``;

          try {
            await ctx.reply(message, { parse_mode: 'Markdown' });
          } catch {
            // Fallback to plain text if markdown fails
            await ctx.reply(`📄 ${filePath}\n\n${displayContent}`);
          }

          if (truncated) {
            await ctx.reply('File was truncated. Use /file <path> --raw to get the full file.');
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to read file';
        await ctx.reply(`Error: ${message}`);
      }
    });

    // /diff - Request git diff for a file or path
    this.bot.command('diff', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      const execAsync = promisify(exec);

      try {
        let gitCommand: string;
        let description: string;

        if (args.length === 0) {
          // Show all changes
          gitCommand = 'git diff';
          description = 'All unstaged changes';
        } else if (args[0] === '--staged' || args[0] === '--cached') {
          // Show staged changes
          const filePath = args.slice(1).join(' ');
          gitCommand = filePath ? `git diff --staged -- "${filePath}"` : 'git diff --staged';
          description = filePath ? `Staged changes in ${filePath}` : 'All staged changes';
        } else if (args[0] === '--stat') {
          // Show diff stat
          const filePath = args.slice(1).join(' ');
          gitCommand = filePath ? `git diff --stat -- "${filePath}"` : 'git diff --stat';
          description = filePath ? `Diff stats for ${filePath}` : 'Diff stats for all changes';
        } else {
          // Show diff for specific file/path
          const filePath = args.join(' ');
          gitCommand = `git diff -- "${filePath}"`;
          description = `Changes in ${filePath}`;
        }

        const { stdout, stderr } = await execAsync(gitCommand, {
          cwd: session.workingDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });

        if (stderr && !stdout) {
          await ctx.reply(`Git error: ${stderr}`);
          return;
        }

        if (!stdout || stdout.trim() === '') {
          await ctx.reply(`No changes found. ${description}`);
          return;
        }

        // Truncate if too long
        const maxLength = 4000;
        const truncated = stdout.length > maxLength;
        const displayContent = truncated
          ? stdout.slice(0, maxLength) + '\n...(truncated)'
          : stdout;

        const message = `📊 ${description}\n\n\`\`\`diff\n${displayContent}\n\`\`\``;

        try {
          await ctx.reply(message, { parse_mode: 'Markdown' });
        } catch {
          // Fallback to plain text if markdown fails
          await ctx.reply(`📊 ${description}\n\n${displayContent}`);
        }

        if (truncated) {
          await ctx.reply(
            'Diff was truncated. Options:\n' +
            '  /diff --stat - Show summary only\n' +
            '  /diff <specific-file> - Show diff for one file'
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get diff';
        if (message.includes('not a git repository')) {
          await ctx.reply('Error: Working directory is not a git repository.');
        } else {
          await ctx.reply(`Error: ${message}`);
        }
      }
    });

    // /log - View recent session output history
    this.bot.command('log', async (ctx) => {
      const args = ctx.message.text.split(' ').slice(1);
      const count = Math.min(parseInt(args[0], 10) || 20, TelegramBot.MAX_OUTPUT_HISTORY);

      if (this.outputHistory.length === 0) {
        await ctx.reply('No output history available. Start a session and interact with Claude first.');
        return;
      }

      const recentLines = this.outputHistory.slice(-count);
      const output = recentLines.join('\n');

      // Truncate if too long
      const maxLength = 4000;
      const truncated = output.length > maxLength;
      const displayContent = truncated
        ? output.slice(0, maxLength) + '\n...(truncated)'
        : output;

      await ctx.reply(
        `📜 Last ${recentLines.length} output lines:\n\n${displayContent}`,
        { parse_mode: undefined }
      );

      if (truncated) {
        await ctx.reply(`Use /log <n> to see fewer lines (max ${TelegramBot.MAX_OUTPUT_HISTORY})`);
      }
    });

    // /pwd - Quick working directory check
    this.bot.command('pwd', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session, source } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      const sourceInfo = source === 'thread-bound' ? ' (thread-bound)' : '';
      await this.replyWithThreadSupport(ctx, `📂 ${session.workingDir}${sourceInfo}`, messageThreadId);
    });

    // /git - Common git operations
    this.bot.command('git', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      const subcommand = args[0]?.toLowerCase();
      const execAsync = promisify(exec);

      try {
        let gitCommand: string;
        let description: string;

        switch (subcommand) {
          case 'status':
          case 's':
            gitCommand = 'git status --short';
            description = 'Git Status';
            break;
          case 'branch':
          case 'b':
            gitCommand = 'git branch -vv';
            description = 'Git Branches';
            break;
          case 'log':
          case 'l':
            const logCount = parseInt(args[1], 10) || 10;
            gitCommand = `git log --oneline -${logCount}`;
            description = `Last ${logCount} Commits`;
            break;
          case 'stash':
            gitCommand = 'git stash list';
            description = 'Git Stashes';
            break;
          case 'remote':
            gitCommand = 'git remote -v';
            description = 'Git Remotes';
            break;
          default:
            await ctx.reply(
              'Git Quick Commands:\n\n' +
              '/git status (s) - Short status\n' +
              '/git branch (b) - List branches\n' +
              '/git log [n] (l) - Recent commits\n' +
              '/git stash - List stashes\n' +
              '/git remote - List remotes\n\n' +
              'For full git operations, use /diff or send git commands to Claude.'
            );
            return;
        }

        const { stdout, stderr } = await execAsync(gitCommand, {
          cwd: session.workingDir,
          maxBuffer: 1024 * 1024,
        });

        const output = stdout || stderr || '(no output)';
        const maxLength = 4000;
        const truncated = output.length > maxLength;
        const displayContent = truncated
          ? output.slice(0, maxLength) + '\n...(truncated)'
          : output;

        await ctx.reply(`📊 ${description}\n\n\`\`\`\n${displayContent}\n\`\`\``, { parse_mode: 'Markdown' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Git command failed';
        if (message.includes('not a git repository')) {
          await ctx.reply('Error: Working directory is not a git repository.');
        } else {
          await ctx.reply(`Error: ${message}`);
        }
      }
    });

    // /tree - Directory tree view
    this.bot.command('tree', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      const args = ctx.message.text.split(' ').slice(1);
      const maxDepth = Math.min(parseInt(args[0], 10) || 2, 5); // Default depth 2, max 5
      const targetPath = args[1] || '.';

      try {
        const fullPath = path.isAbsolute(targetPath)
          ? targetPath
          : path.join(session.workingDir, targetPath);

        // Security check
        const resolvedPath = path.resolve(fullPath);
        const resolvedWorkingDir = path.resolve(session.workingDir);
        if (!resolvedPath.startsWith(resolvedWorkingDir) && resolvedPath !== resolvedWorkingDir) {
          await ctx.reply('Error: Cannot access directories outside the session working directory.');
          return;
        }

        const tree = this.buildDirectoryTree(resolvedPath, maxDepth, 0);
        const maxLength = 4000;
        const truncated = tree.length > maxLength;
        const displayContent = truncated
          ? tree.slice(0, maxLength) + '\n...(truncated)'
          : tree;

        await ctx.reply(
          `🌳 Directory Tree (depth ${maxDepth})\n\n\`\`\`\n${displayContent}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to build tree';
        await ctx.reply(`Error: ${message}`);
      }
    });

    // /bookmark - Save/recall prompts
    this.bot.command('bookmark', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const subcommand = args[0]?.toLowerCase();

      // Get or create user's bookmarks
      if (!this.userBookmarks.has(userId)) {
        this.userBookmarks.set(userId, new Map());
      }
      const bookmarks = this.userBookmarks.get(userId)!;

      if (!subcommand) {
        // Show usage
        await ctx.reply(
          'Bookmark Commands:\n\n' +
          '/bookmark list - Show all bookmarks\n' +
          '/bookmark save <name> <prompt> - Save a prompt\n' +
          '/bookmark <name> - Send saved prompt to Claude\n' +
          '/bookmark delete <name> - Delete a bookmark\n\n' +
          `You have ${bookmarks.size} saved bookmarks.`
        );
        return;
      }

      if (subcommand === 'list') {
        if (bookmarks.size === 0) {
          await ctx.reply('No bookmarks saved. Use /bookmark save <name> <prompt>');
          return;
        }

        let list = '📑 Your Bookmarks:\n\n';
        for (const [name, prompt] of bookmarks) {
          const preview = prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt;
          list += `• *${name}*: ${preview}\n`;
        }
        await ctx.reply(list, { parse_mode: 'Markdown' });
        return;
      }

      if (subcommand === 'save') {
        const name = args[1];
        const prompt = args.slice(2).join(' ');

        if (!name || !prompt) {
          await ctx.reply('Usage: /bookmark save <name> <prompt>');
          return;
        }

        bookmarks.set(name, prompt);
        await ctx.reply(`✅ Bookmark "${name}" saved.`);
        return;
      }

      if (subcommand === 'delete') {
        const name = args[1];
        if (!name) {
          await ctx.reply('Usage: /bookmark delete <name>');
          return;
        }

        if (bookmarks.delete(name)) {
          await ctx.reply(`🗑️ Bookmark "${name}" deleted.`);
        } else {
          await ctx.reply(`Bookmark "${name}" not found.`);
        }
        return;
      }

      // Try to use as bookmark name
      const savedPrompt = bookmarks.get(subcommand);
      if (savedPrompt) {
        const chatId = ctx.chat.id;
        const messageThreadId = this.extractThreadId(ctx.message);

        // Resolve session based on thread context
        const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx,
            'No active session. Use /new to create one.',
            messageThreadId
          );
          return;
        }

        try {
          const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, userId);
          this.trackOutgoingRun(sessionId, savedPrompt, runContext);
          this.sessionManager.sendToSession(sessionId, savedPrompt);
          await this.replyWithThreadSupport(ctx, `📤 Sent bookmark "${subcommand}" to Claude.`, messageThreadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'No active session';
          await this.replyWithThreadSupport(ctx, `Error: ${message}. Use /new to create a session.`, messageThreadId);
        }
      } else {
        await ctx.reply(`Bookmark "${subcommand}" not found. Use /bookmark list to see available bookmarks.`);
      }
    });

    // /context - Show conversation context size
    this.bot.command('context', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      if (this.lastContextInfo.tokens) {
        const pct = this.lastContextInfo.percentage ? `(${this.lastContextInfo.percentage}%)` : '';
        const ago = this.lastContextInfo.timestamp
          ? Math.round((Date.now() - this.lastContextInfo.timestamp.getTime()) / 1000)
          : 0;

        await ctx.reply(
          `📊 Context Usage\n\n` +
          `Tokens: ~${this.lastContextInfo.tokens.toLocaleString()} ${pct}\n` +
          `Last updated: ${ago}s ago\n\n` +
          `Send a message to Claude to update context info.`
        );
      } else {
        await ctx.reply(
          'Context information not yet available.\n' +
          'Send a message to Claude and context info will be captured from the output.'
        );
      }
    });

    // /cost - Send /cost to Claude and format results
    this.bot.command('cost', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session || !sessionId) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      try {
        await this.replyWithThreadSupport(ctx, '💰 Fetching cost information from Claude...', messageThreadId);

        // Set up a callback to capture the response
        this.pendingCostCallback = (response: string) => {
          this.formatAndSendCostInfo(chatId, response, messageThreadId);
        };

        // Send /cost to Claude (use resolved session)
        const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, ctx.from?.id);
        this.trackOutgoingRun(sessionId, '/cost', runContext);
        this.sessionManager.sendToSession(sessionId, '/cost');

        // Timeout after 10 seconds
        setTimeout(() => {
          if (this.pendingCostCallback) {
            this.pendingCostCallback = null;
            ctx.reply('Timeout waiting for cost information. Claude may still be processing.').catch(() => {});
          }
        }, 10000);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get cost info';
        await ctx.reply(`Error: ${message}`);
      }
    });

    // /report - Send latest run report as HTML
    this.bot.command('report', async (ctx) => {
      if (!this.reportingConfig.enabled) {
        await ctx.reply('Run reporting is disabled.');
        return;
      }

      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);
      const userId = ctx.from?.id;

      const args = this.parseCommandArgs(ctx.message.text, 'report');
      const runIdArg = args[0];

      let run: RunRecord | null = null;

      if (runIdArg) {
        run = this.runTracker.findRunById(runIdArg);
      } else {
        const { sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (sessionId) {
          run = this.runTracker.getLatestRun(sessionId);
          if (run && !run.context) {
            run.context = this.buildRunContext(sessionId, chatId, messageThreadId, userId);
          }
        }
      }

      if (!run) {
        await this.replyWithThreadSupport(ctx, 'No run report found for this session.', messageThreadId);
        return;
      }

      if (!run.context) {
        run.context = this.buildRunContext(run.sessionId, chatId, messageThreadId, userId);
      }

      await this.sendRunReport(run);
    });

    // /reporthistory - Generate a report for already completed historical runs
    this.bot.command('reporthistory', async (ctx) => {
      if (!this.reportingConfig.enabled) {
        await ctx.reply('Run reporting is disabled.');
        return;
      }

      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);
      const userId = ctx.from?.id;

      const args = this.parseCommandArgs(ctx.message.text, 'reporthistory');
      const parsed = this.parseReportHistoryArgs(args);
      if (parsed.error) {
        await this.replyWithThreadSupport(ctx, parsed.error, messageThreadId);
        return;
      }

      let projectPath = parsed.projectPath;
      if (!projectPath) {
        const { sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (sessionId) {
          const session = this.sessionManager.getSession(sessionId);
          projectPath = session?.workingDir;
        }
      }

      if (!projectPath) {
        await this.replyWithThreadSupport(
          ctx,
          'Usage: /reporthistory <projectPath> [--index N] [--session SESSION_ID_PREFIX] [--all]',
          messageThreadId
        );
        return;
      }

      try {
        const selection = await this.historicalRunImporter.findRun({
          projectPath,
          runIndex: parsed.runIndex,
          sessionIdPrefix: parsed.sessionIdPrefix,
          includeGeneral: parsed.includeGeneral,
        });

        if (!selection) {
          await this.replyWithThreadSupport(
            ctx,
            `No historical ${parsed.includeGeneral ? '' : 'babysitter '}runs found for ${projectPath}.`,
            messageThreadId
          );
          return;
        }

        const baseContext = selection.run.context ?? {};
        const liveContext = this.buildRunContext(selection.run.sessionId, chatId, messageThreadId, userId);
        selection.run.context = {
          ...baseContext,
          chatId: liveContext.chatId ?? baseContext.chatId,
          threadId: liveContext.threadId ?? baseContext.threadId,
          userId: liveContext.userId ?? baseContext.userId,
          sessionName: baseContext.sessionName ?? liveContext.sessionName ?? selection.sessionId,
          workingDir: baseContext.workingDir ?? liveContext.workingDir ?? projectPath,
        };

        await this.sendRunReport(selection.run);

        const started = new Date(selection.run.startedAt).toISOString();
        await this.replyWithThreadSupport(
          ctx,
          `Historical run ${selection.runIndex}/${selection.totalRuns} from session ${selection.sessionId.slice(0, 8)} at ${started}.`,
          messageThreadId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate historical report';
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /babysit - Alias for /babysitter:call (forwards to Claude as skill)
    this.bot.command('babysit', async (ctx) => {
      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Resolve session based on thread context
      const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
      if (!session || !sessionId) {
        await this.replyWithThreadSupport(ctx,
          'No active session. Use /new to create one.',
          messageThreadId
        );
        return;
      }

      try {
        // Get any arguments after /babysit
        const args = ctx.message.text.replace(/^\/babysit\s*/, '').trim();

        // Forward to Claude as /babysitter:call with the same arguments
        const fullCommand = args ? `/babysitter:call ${args}` : '/babysitter:call';
        const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, ctx.from?.id);
        this.trackOutgoingRun(sessionId, fullCommand, runContext);
        this.sessionManager.sendToSession(sessionId, fullCommand);

        await this.replyWithThreadSupport(ctx, 'Sent to the Babysitter.', messageThreadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send to Babysitter';
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // /streaming - Configure streaming mode (Bot API 9.3)
    this.bot.command('streaming', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const subcommand = args[0]?.toLowerCase();

      // Check if streaming is configured
      if (!this.streamingConfig.enabled) {
        await ctx.reply(
          'Streaming is not enabled in bot configuration.\n' +
          'Set streamingConfig.enabled=true in your bot config.'
        );
        return;
      }

      if (!subcommand) {
        // Show current settings
        const currentMode = this.getUserStreamingMode(userId);
        await ctx.reply(
          `Streaming Settings\n\n` +
          `Mode: ${currentMode}\n` +
          `Block size: ${this.streamingConfig.blockSize} chars\n` +
          `Update interval: ${this.streamingConfig.updateIntervalMs}ms\n\n` +
          `Usage:\n` +
          `/streaming partial - Stream as text arrives\n` +
          `/streaming block - Send in blocks\n` +
          `/streaming off - Disable streaming\n\n` +
          `Note: Streaming uses Telegram Bot API 9.3 draft messages.`
        );
        return;
      }

      if (subcommand === 'partial' || subcommand === 'block' || subcommand === 'off') {
        this.setUserStreamingMode(userId, subcommand as StreamingMode);
        await ctx.reply(`Streaming mode set to: ${subcommand}`);
      } else {
        await ctx.reply('Invalid mode. Use: partial, block, or off');
      }
    });

    // /threads - Configure threaded mode (forum topics)
    this.bot.command('threads', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const subcommand = args[0]?.toLowerCase();

      if (!subcommand) {
        // Show current settings
        const isEnabled = this.isThreadedModeEnabledForUser(userId);
        const currentThreadId = this.getUserThreadId(chatId, userId);
        const forumEnabled = this.threadManager?.isForumEnabled(chatId) ?? false;

        await ctx.reply(
          `Threaded Mode Settings\n\n` +
          `Threaded mode: ${isEnabled ? 'ON' : 'OFF'}\n` +
          `Forum enabled: ${forumEnabled ? 'Yes' : 'No'}\n` +
          `Current thread ID: ${currentThreadId ?? 'None'}\n\n` +
          `Usage:\n` +
          `/threads on - Enable threaded mode\n` +
          `/threads off - Disable threaded mode\n` +
          `/threads set <id> - Set current thread ID\n` +
          `/threads clear - Clear thread association\n\n` +
          `Use /topic to manage forum topics.`
        );
        return;
      }

      if (subcommand === 'on') {
        this.setUserThreadedMode(userId, true);
        await ctx.reply('Threaded mode enabled.');
      } else if (subcommand === 'off') {
        this.setUserThreadedMode(userId, false);
        await ctx.reply('Threaded mode disabled.');
      } else if (subcommand === 'set') {
        const threadId = parseInt(args[1], 10);
        if (isNaN(threadId)) {
          await ctx.reply('Usage: /threads set <thread_id>');
          return;
        }
        this.setUserThread(chatId, userId, threadId);
        await ctx.reply(`Thread ID set to: ${threadId}`);
      } else if (subcommand === 'clear') {
        if (this.threadManager) {
          this.threadManager.clearThread(chatId, userId);
        }
        await ctx.reply('Thread association cleared.');
      } else {
        await ctx.reply('Invalid subcommand. Use: on, off, set <id>, or clear');
      }
    });

    // /topic - Manage forum topics
    this.bot.command('topic', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const args = ctx.message.text.split(' ').slice(1);
      const subcommand = args[0]?.toLowerCase();

      if (!this.threadManager) {
        await ctx.reply(
          'Topic management is not available.\n' +
          'Enable threaded mode in your bot configuration.'
        );
        return;
      }

      if (!subcommand) {
        // Show usage and list topics
        const topics = this.threadManager.listTopics(chatId);
        const topicList = topics.length > 0
          ? topics.map(t => `  - ${t.name} (ID: ${t.message_thread_id})`).join('\n')
          : '  No cached topics';

        await ctx.reply(
          `Topic Management\n\n` +
          `Cached topics:\n${topicList}\n\n` +
          `Usage:\n` +
          `/topic create <name> - Create a new topic\n` +
          `/topic list - List cached topics\n` +
          `/topic use <id> - Use a topic for messages\n` +
          `/topic check - Check if forum is enabled\n\n` +
          `Note: This chat must be a supergroup with forum topics enabled.`
        );
        return;
      }

      if (subcommand === 'create') {
        const topicName = args.slice(1).join(' ');
        if (!topicName) {
          await ctx.reply('Usage: /topic create <name>');
          return;
        }

        try {
          const topic = await this.threadManager.createTopic(chatId, { name: topicName });
          await ctx.reply(
            `Topic created!\n\n` +
            `Name: ${topic.name}\n` +
            `Thread ID: ${topic.message_thread_id}\n\n` +
            `Use /threads set ${topic.message_thread_id} to use this topic.`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create topic';
          await ctx.reply(`Error: ${message}`);
        }
      } else if (subcommand === 'list') {
        const topics = this.threadManager.listTopics(chatId);
        if (topics.length === 0) {
          await ctx.reply('No cached topics. Create a topic with /topic create <name>');
          return;
        }

        const topicList = topics.map(t => `- ${t.name} (ID: ${t.message_thread_id})`).join('\n');
        await ctx.reply(`Cached topics:\n\n${topicList}`);
      } else if (subcommand === 'use') {
        const threadId = parseInt(args[1], 10);
        if (isNaN(threadId)) {
          await ctx.reply('Usage: /topic use <thread_id>');
          return;
        }
        this.setUserThread(chatId, userId, threadId);
        this.setUserThreadedMode(userId, true);
        await ctx.reply(`Now using topic with thread ID: ${threadId}`);
      } else if (subcommand === 'check') {
        try {
          const isForumEnabled = await this.threadManager.checkForumEnabled(chatId);
          await ctx.reply(`Forum topics: ${isForumEnabled ? 'Enabled' : 'Not enabled'}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to check forum status';
          await ctx.reply(`Error: ${message}`);
        }
      } else {
        await ctx.reply('Invalid subcommand. Use: create, list, use, or check');
      }
    });

    // /threadsession - Show the active session for the current thread
    this.bot.command('threadsession', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const messageThreadId = this.extractThreadId(ctx.message);

      if (!this.threadManager) {
        await this.replyWithThreadSupport(ctx,
          'Threaded mode is not enabled.\n' +
          'Enable threaded mode in your bot configuration.',
          messageThreadId
        );
        return;
      }

      if (messageThreadId === undefined) {
        await ctx.reply(
          'This command should be used from within a forum topic thread.\n' +
          'Send this command from a thread to see which session is bound to it.'
        );
        return;
      }

      // Check ThreadManager for session-to-thread mapping
      const sessionId = this.threadManager.getSessionForThread(chatId, messageThreadId);

      if (sessionId) {
        const session = this.sessionManager.getSession(sessionId);
        if (session) {
          await this.replyWithThreadSupport(ctx,
            `Thread Session Info\n\n` +
            `Thread ID: ${messageThreadId}\n` +
            `Session ID: \`${session.id}\`\n` +
            `Session Name: ${session.name}\n` +
            `Working Directory: ${session.workingDir}\n` +
            `Status: ${session.status}`,
            messageThreadId,
            'Markdown'
          );
        } else {
          await this.replyWithThreadSupport(ctx,
            `Thread ${messageThreadId} is bound to session ${sessionId.substring(0, 8)}...\n` +
            `But the session no longer exists. Use /new to create a new session.`,
            messageThreadId
          );
        }
      } else {
        // Also check contextual session from SessionManager
        const sessionContext: SessionContext = {
          chatId,
          threadId: messageThreadId,
          userId,
        };
        const contextSession = this.sessionManager.getActiveSessionForContext(sessionContext);

        if (contextSession) {
          await this.replyWithThreadSupport(ctx,
            `Thread Session Info (via context)\n\n` +
            `Thread ID: ${messageThreadId}\n` +
            `Session ID: \`${contextSession.id}\`\n` +
            `Session Name: ${contextSession.name}\n` +
            `Working Directory: ${contextSession.workingDir}\n` +
            `Status: ${contextSession.status}`,
            messageThreadId,
            'Markdown'
          );
        } else {
          await this.replyWithThreadSupport(ctx,
            `No session bound to this thread (ID: ${messageThreadId}).\n\n` +
            `Use /new to create a session that will be bound to this thread.`,
            messageThreadId
          );
        }
      }
    });

    // /threadsessions - List all sessions and their thread bindings
    this.bot.command('threadsessions', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const messageThreadId = this.extractThreadId(ctx.message);

      // Get all sessions
      const sessions = this.sessionManager.listSessions();

      if (sessions.length === 0) {
        await this.replyWithThreadSupport(ctx,
          'No active sessions.\n\n' +
          'Use /new to create a new session.',
          messageThreadId
        );
        return;
      }

      // Build session list with thread bindings
      let message = 'All Sessions and Thread Bindings:\n\n';

      for (const session of sessions) {
        // Check if this session is bound to a thread via ThreadManager
        let threadBinding = 'No thread';
        if (this.threadManager) {
          const threadMapping = this.threadManager.getThreadForSession(session.id);
          if (threadMapping) {
            threadBinding = `Thread: ${threadMapping.threadId} (Chat: ${threadMapping.chatId})`;
          }
        }

        message += `Session: ${session.name}\n`;
        message += `  ID: \`${session.id.substring(0, 8)}...\`\n`;
        message += `  Status: ${session.status}\n`;
        message += `  Dir: ${session.workingDir}\n`;
        message += `  -> ${threadBinding}\n\n`;
      }

      message += 'Use /linksession <id> to link a session to the current thread.\n';
      message += 'Use /unlinksession to unlink the session from the current thread.';

      await this.replyWithThreadSupport(ctx, message, messageThreadId, 'Markdown');
    });

    // /linksession <sessionId> - Link a specific session to the current thread
    this.bot.command('linksession', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const messageThreadId = this.extractThreadId(ctx.message);
      const args = ctx.message.text.split(' ').slice(1);
      const sessionIdArg = args[0];

      if (!sessionIdArg) {
        await this.replyWithThreadSupport(ctx,
          'Usage: /linksession <sessionId>\n\n' +
          'Link a specific session to the current thread.\n' +
          'Use /threadsessions to see available session IDs.',
          messageThreadId
        );
        return;
      }

      if (messageThreadId === undefined) {
        await ctx.reply(
          'This command should be used from within a forum topic thread.\n' +
          'Send this command from a thread to link a session to it.'
        );
        return;
      }

      if (!this.threadManager) {
        await this.replyWithThreadSupport(ctx,
          'Threaded mode is not enabled.\n' +
          'Enable threaded mode in your bot configuration.',
          messageThreadId
        );
        return;
      }

      // Find session by ID (support partial ID match)
      const sessions = this.sessionManager.listSessions();
      const matchingSessions = sessions.filter(s =>
        s.id === sessionIdArg || s.id.startsWith(sessionIdArg)
      );

      if (matchingSessions.length === 0) {
        await this.replyWithThreadSupport(ctx,
          `Session not found: ${sessionIdArg}\n\n` +
          'Use /threadsessions to see available sessions.',
          messageThreadId
        );
        return;
      }

      if (matchingSessions.length > 1) {
        const sessionList = matchingSessions.map(s =>
          `  - ${s.name} (${s.id.substring(0, 8)}...)`
        ).join('\n');
        await this.replyWithThreadSupport(ctx,
          `Multiple sessions match "${sessionIdArg}":\n${sessionList}\n\n` +
          'Please provide a more specific session ID.',
          messageThreadId
        );
        return;
      }

      const session = matchingSessions[0];

      // Bind session to this thread (ThreadManager handles all session-thread mapping)
      this.threadManager.setSessionForThread(chatId, messageThreadId, session.id);

      // Also set in SessionManager's contextual sessions (for backward compatibility)
      const sessionContext: SessionContext = {
        chatId,
        threadId: messageThreadId,
        userId,
      };
      this.sessionManager.setActiveSessionForContext(sessionContext, session.id);

      await this.replyWithThreadSupport(ctx,
        `Session linked to this thread!\n\n` +
        `Session: ${session.name}\n` +
        `ID: \`${session.id.substring(0, 8)}...\`\n` +
        `Thread: ${messageThreadId}\n\n` +
        `Messages in this thread will now use this session.`,
        messageThreadId,
        'Markdown'
      );
    });

    // /unlinksession - Unlink the session from the current thread
    this.bot.command('unlinksession', async (ctx) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      const messageThreadId = this.extractThreadId(ctx.message);

      if (messageThreadId === undefined) {
        await ctx.reply(
          'This command should be used from within a forum topic thread.\n' +
          'Send this command from a thread to unlink its session.'
        );
        return;
      }

      if (!this.threadManager) {
        await this.replyWithThreadSupport(ctx,
          'Threaded mode is not enabled.\n' +
          'Enable threaded mode in your bot configuration.',
          messageThreadId
        );
        return;
      }

      // Check if there's a session bound to this thread
      const boundSessionId = this.threadManager.getSessionForThread(chatId, messageThreadId);

      if (!boundSessionId) {
        // Also check contextual session
        const sessionContext: SessionContext = {
          chatId,
          threadId: messageThreadId,
          userId,
        };
        const contextSession = this.sessionManager.getActiveSessionForContext(sessionContext);

        if (!contextSession) {
          await this.replyWithThreadSupport(ctx,
            `No session is bound to this thread (ID: ${messageThreadId}).\n\n` +
            'Use /linksession <id> to link a session to this thread.',
            messageThreadId
          );
          return;
        }

        // Clear contextual session only
        this.sessionManager.clearActiveSessionForContext(sessionContext);
        await this.replyWithThreadSupport(ctx,
          `Session unlinked from this thread.\n\n` +
          `Session: ${contextSession.name}\n` +
          `Thread: ${messageThreadId}\n\n` +
          `Messages in this thread will now use the global active session.`,
          messageThreadId
        );
        return;
      }

      const session = this.sessionManager.getSession(boundSessionId);
      const sessionName = session?.name || '(unknown)';

      // Clear thread-session mapping in ThreadManager (handles all session-thread cleanup)
      this.threadManager.clearSessionForThread(chatId, messageThreadId);

      // Clear contextual session in SessionManager (for backward compatibility)
      const sessionContext: SessionContext = {
        chatId,
        threadId: messageThreadId,
        userId,
      };
      this.sessionManager.clearActiveSessionForContext(sessionContext);

      await this.replyWithThreadSupport(ctx,
        `Session unlinked from this thread.\n\n` +
        `Session: ${sessionName}\n` +
        `Thread: ${messageThreadId}\n\n` +
        `Messages in this thread will now use the global active session.`,
        messageThreadId
      );
    });
  }

  /**
   * Build a directory tree string
   */
  private buildDirectoryTree(dirPath: string, maxDepth: number, currentDepth: number, prefix = ''): string {
    if (currentDepth > maxDepth) return '';

    const entries: string[] = [];
    try {
      const items = fs.readdirSync(dirPath);

      // Filter out common ignored directories
      const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv']);
      const filtered = items.filter(item => !ignored.has(item) && !item.startsWith('.'));

      // Sort: directories first, then files
      const sorted = filtered.sort((a, b) => {
        const aIsDir = fs.statSync(path.join(dirPath, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(dirPath, b)).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
      });

      // Limit entries to avoid huge outputs
      const maxEntries = 50;
      const limited = sorted.slice(0, maxEntries);
      const hasMore = sorted.length > maxEntries;

      for (let i = 0; i < limited.length; i++) {
        const item = limited[i];
        const itemPath = path.join(dirPath, item);
        const isLast = i === limited.length - 1 && !hasMore;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = isLast ? '    ' : '│   ';

        try {
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            entries.push(`${prefix}${connector}📁 ${item}/`);
            if (currentDepth < maxDepth) {
              const subtree = this.buildDirectoryTree(itemPath, maxDepth, currentDepth + 1, prefix + childPrefix);
              if (subtree) entries.push(subtree);
            }
          } else {
            entries.push(`${prefix}${connector}📄 ${item}`);
          }
        } catch {
          entries.push(`${prefix}${connector}❓ ${item} (inaccessible)`);
        }
      }

      if (hasMore) {
        entries.push(`${prefix}└── ... and ${sorted.length - maxEntries} more`);
      }
    } catch (error) {
      return `${prefix}(error reading directory)`;
    }

    return entries.join('\n');
  }

  /**
   * Format and send cost information to user
   */
  private async formatAndSendCostInfo(chatId: number, response: string, threadId?: number): Promise<void> {
    try {
      // Parse the cost response from Claude
      // Typical format includes session cost, total cost, token usage

      let formatted = '💰 *Cost Summary*\n\n';

      // Look for common patterns in cost output
      // Match formats like "Session: $0.15", "Session cost: $0.15", "session $0.15"
      const sessionCostMatch = response.match(/session\s*(?:cost)?[:\s]+\$?([\d.]+)/i);
      const totalCostMatch = response.match(/total\s*(?:cost)?[:\s]+\$?([\d.]+)/i);
      const inputTokensMatch = response.match(/input[:\s]+([\d,]+)\s*tokens?/i);
      const outputTokensMatch = response.match(/output[:\s]+([\d,]+)\s*tokens?/i);

      if (sessionCostMatch) {
        formatted += `Session: $${sessionCostMatch[1]}\n`;
      }
      if (totalCostMatch) {
        formatted += `Total: $${totalCostMatch[1]}\n`;
      }
      if (inputTokensMatch || outputTokensMatch) {
        formatted += '\nTokens:\n';
        if (inputTokensMatch) formatted += `  Input: ${inputTokensMatch[1]}\n`;
        if (outputTokensMatch) formatted += `  Output: ${outputTokensMatch[1]}\n`;
      }

      // If we couldn't parse structured data, just show the raw response
      if (!sessionCostMatch && !totalCostMatch && !inputTokensMatch) {
        formatted = '💰 Cost Information:\n\n' + response.slice(0, 2000);
      }

      const options: { parse_mode: 'Markdown'; message_thread_id?: number } = { parse_mode: 'Markdown' };
      if (threadId !== undefined) {
        options.message_thread_id = threadId;
      }
      await this.bot.telegram.sendMessage(chatId, formatted, options);
    } catch (error) {
      // Fallback to plain text
      const options: { message_thread_id?: number } = {};
      if (threadId !== undefined) {
        options.message_thread_id = threadId;
      }
      await this.bot.telegram.sendMessage(chatId, `💰 Cost Information:\n\n${response.slice(0, 2000)}`, options);
    }
  }

  /**
   * Set up callback query handlers for inline buttons
   */
  private setupCallbackHandlers(): void {
    // Handle answer selections
    this.bot.action(/^answer:(.+)$/, async (ctx) => {
      const match = ctx.match;
      if (!match) return;

      const selection = match[1];
      const chatId = ctx.chat?.id;

      if (!chatId) {
        await ctx.answerCbQuery('Error: Could not identify chat');
        return;
      }

      try {
        if (selection === 'custom') {
          // User wants to type custom response
          this.awaitingCustomInput.add(chatId);
          await ctx.answerCbQuery('Type your custom response');
          await ctx.reply('Please type your custom response:');
        } else {
          // User selected a numbered option
          const optionIndex = parseInt(selection, 10);
          const pending = this.pendingQuestions.get(chatId);
          const messageThreadId = (ctx.callbackQuery as { message?: { message_thread_id?: number } }).message?.message_thread_id;

          if (pending && pending.question.options[optionIndex]) {
            const selectedOption = pending.question.options[optionIndex];

            // Use the session ID that was stored when the question was asked
            // This ensures the answer goes to the correct session, not whatever session
            // is currently active or bound to the user's current thread
            const sessionId = pending.sessionId;
            const session = this.sessionManager.getSession(sessionId);

            if (!session) {
              await ctx.answerCbQuery('Session no longer active');
              console.log(`[Answer] Session ${sessionId.substring(0, 8)}... no longer exists, cannot send answer`);
              this.pendingQuestions.delete(chatId);
              return;
            }

            // Resume normal message forwarding now that user has responded (per-session tracking)
            this.waitingForUserResponse.set(sessionId, false);
            console.log(`[Answer] User responded for session ${sessionId.substring(0, 8)}..., resuming message forwarding`);

            // Send the answer as a new message to Claude using the STORED session (the one that asked)
            console.log(`[Answer] Sending answer to ORIGINAL session: "${selectedOption.label}" (session: ${sessionId.substring(0, 8)}...)`);
            const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, ctx.from?.id);
            this.trackOutgoingRun(sessionId, selectedOption.label, runContext, true);
            this.sessionManager.sendToSession(sessionId, selectedOption.label);

            await ctx.answerCbQuery(`Selected: ${selectedOption.label}`);
            await ctx.editMessageText(
              `You selected: *${selectedOption.label}*`,
              { parse_mode: 'Markdown' }
            );

            // Clear pending question
            this.pendingQuestions.delete(chatId);
          } else {
            await ctx.answerCbQuery('Invalid selection');
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error processing selection';
        await ctx.answerCbQuery(message);
      }
    });
  }

  /**
   * Check if a message is a bot command (vs a Claude skill invocation)
   */
  private isBotCommand(text: string): boolean {
    if (!text.startsWith('/')) return false;

    // Extract command name from "/command" or "/command@botname" or "/command args"
    const match = text.match(/^\/([a-zA-Z0-9_]+)/);
    if (!match) return false;

    const commandName = match[1].toLowerCase();
    return BOT_COMMANDS.has(commandName);
  }

  /**
   * Check if a message in a group chat is directed at this bot
   * Returns true if:
   * - It's a private chat (always process)
   * - Message starts with / (command)
   * - Message mentions the bot (@botname)
   * - Message is a reply to the bot's message
   */
  private isMessageForBot(ctx: Context, text: string): boolean {
    const chatType = ctx.chat?.type;

    // Always process messages in private chats
    if (chatType === 'private') {
      return true;
    }

    // In groups/supergroups, check if message is directed at bot
    if (chatType === 'group' || chatType === 'supergroup') {
      // Check 1: Message starts with a command
      if (text.startsWith('/')) {
        // If command includes @botname, verify it's for this bot
        const botMatch = text.match(/^\/[a-zA-Z0-9_]+@([a-zA-Z0-9_]+)/);
        if (botMatch) {
          return botMatch[1].toLowerCase() === this.botUsername?.toLowerCase();
        }
        // Command without @botname - process it (Telegram delivers to all bots)
        return true;
      }

      // Check 2: Message mentions the bot
      if (this.botUsername && text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`)) {
        return true;
      }

      // Check 3: Message is a reply to the bot's message
      const replyToMessage = (ctx.message as { reply_to_message?: { from?: { username?: string } } })?.reply_to_message;
      if (replyToMessage?.from?.username?.toLowerCase() === this.botUsername?.toLowerCase()) {
        return true;
      }

      // Message is not directed at the bot - ignore it
      return false;
    }

    // Channels - ignore
    return false;
  }

  /**
   * Strip bot mention from message text for cleaner processing
   */
  private stripBotMention(text: string): string {
    if (!this.botUsername) return text;
    // Remove @botname from the message
    return text.replace(new RegExp(`@${this.botUsername}\\b`, 'gi'), '').trim();
  }

  /**
   * Set up message handlers for text input
   */
  private setupMessageHandlers(): void {
    this.bot.on('text', async (ctx) => {
      const rawText = ctx.message.text;
      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;

      // Extract and track message_thread_id if present (forum topic messages)
      const incomingThreadId = this.extractThreadId(ctx.message);
      if (userId && incomingThreadId !== undefined && this.threadManager) {
        // Automatically track the thread the user is messaging from
        this.setUserThread(chatId, userId, incomingThreadId);
        this.setUserThreadedMode(userId, true);
        console.log(`[Threads] User ${userId} messaging from thread ${incomingThreadId} in chat ${chatId}`);
      }

      // IMPORTANT: Check if we're awaiting custom input FIRST (before group filtering)
      // This allows users to type custom responses in groups without mentioning the bot
      if (this.awaitingCustomInput.has(chatId)) {
        const text = this.stripBotMention(rawText);

        // Input length validation
        if (text.length > TelegramBot.MAX_MESSAGE_LENGTH) {
          await this.replyWithThreadSupport(ctx,
            `Message too long (${text.length} chars). Maximum allowed: ${TelegramBot.MAX_MESSAGE_LENGTH} characters.`,
            incomingThreadId
          );
          return;
        }

        // Get the stored pending question to find the ORIGINAL session that asked
        const pending = this.pendingQuestions.get(chatId);
        this.awaitingCustomInput.delete(chatId);
        this.pendingQuestions.delete(chatId);

        // Track which chat is actively communicating with the bot
        this.activeChat = chatId;

        // Send custom response as a new message to Claude
        console.log(`[CustomAnswer] Sending as new message: "${text}"`);
        try {
          // Use the stored session ID from the pending question if available
          // This ensures the answer goes to the session that asked, not the current thread's session
          if (pending?.sessionId) {
            const storedSessionId = pending.sessionId;
            const session = this.sessionManager.getSession(storedSessionId);
            if (session) {
              // Resume normal message forwarding for this session (per-session tracking)
              this.waitingForUserResponse.set(storedSessionId, false);
              console.log(`[CustomAnswer] User responded for ORIGINAL session ${storedSessionId.substring(0, 8)}..., resuming message forwarding`);
              const runContext = this.buildRunContext(storedSessionId, chatId, incomingThreadId, userId);
              this.trackOutgoingRun(storedSessionId, text, runContext, true);
              this.sessionManager.sendToSession(storedSessionId, text);
            } else {
              await this.replyWithThreadSupport(ctx,
                'The session that asked this question no longer exists.',
                incomingThreadId
              );
              return;
            }
          } else if (this.threadedModeConfig.enabled && this.threadManager && incomingThreadId !== undefined) {
            // Fallback: Use thread-aware session resolution when no stored session
            // Use ThreadManager as the canonical source for session-thread mappings
            const boundSessionId = this.threadManager.getSessionForThread(chatId, incomingThreadId);

            if (boundSessionId) {
              const session = this.sessionManager.getSession(boundSessionId);
              if (session) {
                // Resume normal message forwarding for this session (per-session tracking)
                this.waitingForUserResponse.set(boundSessionId, false);
                console.log(`[CustomAnswer] User responded for session ${boundSessionId.substring(0, 8)}..., resuming message forwarding`);
                console.log(`[CustomAnswer] Thread ${incomingThreadId} -> Session ${boundSessionId.substring(0, 8)}...`);
                const runContext = this.buildRunContext(boundSessionId, chatId, incomingThreadId, userId);
                this.trackOutgoingRun(boundSessionId, text, runContext, true);
                this.sessionManager.sendToSession(boundSessionId, text);
              } else {
                this.threadManager.clearSessionForThread(chatId, incomingThreadId);
                await this.replyWithThreadSupport(ctx,
                  'The session for this thread no longer exists. Use /new to create one.',
                  incomingThreadId
                );
                return;
              }
            } else {
              // No session bound to this thread - auto-create a new session
              console.log(`[CustomAnswer] Thread ${incomingThreadId} has no binding, auto-creating new session...`);

              try {
                const sessionName = `thread-${incomingThreadId}-${Date.now()}`;
                const newSession = await this.sessionManager.createSession(sessionName);
                this.subscribeToSessionOutput(newSession.id);
                this.threadManager.setSessionForThread(chatId, incomingThreadId, newSession.id);
                console.log(`[CustomAnswer] Auto-created session ${newSession.id.substring(0, 8)}... for thread ${incomingThreadId}`);
                const runContext = this.buildRunContext(newSession.id, chatId, incomingThreadId, userId);
                this.trackOutgoingRun(newSession.id, text, runContext, true);
                this.sessionManager.sendToSession(newSession.id, text);
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                await this.replyWithThreadSupport(ctx, `Failed to create session: ${errorMsg}`, incomingThreadId);
                return;
              }
            }
          } else {
            // Fall back to active session - clear waiting state for it
            const activeSession = this.sessionManager.getActiveSession();
            if (activeSession) {
              this.waitingForUserResponse.set(activeSession.id, false);
              console.log(`[CustomAnswer] User responded for active session ${activeSession.id.substring(0, 8)}..., resuming message forwarding`);
              const runContext = this.buildRunContext(activeSession.id, chatId, incomingThreadId, userId);
              this.trackOutgoingRun(activeSession.id, text, runContext, true);
            }
            this.sessionManager.sendToActiveSession(text);
          }
          await this.replyWithThreadSupport(ctx, `Sent: "${text}"`, incomingThreadId);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'No active session';
          await this.replyWithThreadSupport(ctx, `Error: ${message}. Use /new to create a session.`, incomingThreadId);
        }
        return;
      }

      // Group chat support: Check if message is directed at this bot
      if (!this.isMessageForBot(ctx, rawText)) {
        // Message in group not directed at bot - ignore silently
        return;
      }

      // Strip bot mention from message for cleaner processing
      const text = this.stripBotMention(rawText);

      // Input length validation - security hardening (REM-005)
      if (text.length > TelegramBot.MAX_MESSAGE_LENGTH) {
        await this.replyWithThreadSupport(ctx,
          `Message too long (${text.length} chars). Maximum allowed: ${TelegramBot.MAX_MESSAGE_LENGTH} characters.`,
          incomingThreadId
        );
        return;
      }

      // Skip only if it's a registered bot command (like /new, /list, etc.)
      // Other slash commands (like /babysitter:call, /commit) are Claude skills
      // and should be forwarded to Claude
      if (this.isBotCommand(text)) return;

      // Track which chat is actively communicating with the bot
      this.activeChat = chatId;

      try {
        // Note: Session-thread binding only happens explicitly via /linksession or /new in a thread
        // Regular messages do NOT automatically bind sessions to threads

        console.log(`[Message] INCOMING: chatId=${chatId}, threadId=${incomingThreadId}, text="${text.substring(0, 50)}..."`);
        console.log(`[Message] threadedModeConfig.enabled=${this.threadedModeConfig.enabled}, threadManager=${!!this.threadManager}`);

        // Use per-thread session resolution when threaded mode is enabled
        if (this.threadedModeConfig.enabled && this.threadManager && incomingThreadId !== undefined) {
          console.log(`[Message] Looking up session for thread ${incomingThreadId} in chat ${chatId}`);
          // Use ThreadManager as the canonical source for session-thread mappings
          const boundSessionId = this.threadManager.getSessionForThread(chatId, incomingThreadId);
          console.log(`[Message] Lookup result: boundSessionId=${boundSessionId || 'NOT FOUND'}`)

          if (boundSessionId) {
            // Found a session bound to this thread - send to it directly
            const session = this.sessionManager.getSession(boundSessionId);
            if (session) {
              // If user sends a new message while a question was pending for this session, clear the waiting state
              if (this.waitingForUserResponse.get(boundSessionId)) {
                console.log(`[Message] User sent new message to session ${boundSessionId.substring(0, 8)}..., clearing pending question state`);
                this.waitingForUserResponse.set(boundSessionId, false);
                this.pendingQuestions.delete(chatId);
              }
              console.log(`[Message] Thread ${incomingThreadId} -> Session ${boundSessionId.substring(0, 8)}...`);
              const runContext = this.buildRunContext(boundSessionId, chatId, incomingThreadId, userId);
              this.trackOutgoingRun(boundSessionId, text, runContext);
              this.sessionManager.sendToSession(boundSessionId, text);
            } else {
              // Session was deleted but mapping remains - clean up
              this.threadManager.clearSessionForThread(chatId, incomingThreadId);
              await this.replyWithThreadSupport(ctx,
                'The session for this thread no longer exists. Use /new to create one.',
                incomingThreadId
              );
              return;
            }
          } else {
            // No session bound to this thread - auto-create a new session for this thread
            console.log(`[Message] Thread ${incomingThreadId} has no binding, auto-creating new session...`);

            try {
              // Create a new session for this thread
              const sessionName = `thread-${incomingThreadId}-${Date.now()}`;
              const newSession = await this.sessionManager.createSession(sessionName);

              // Subscribe to the new session's output
              this.subscribeToSessionOutput(newSession.id);

              // Bind the new session to this thread
              this.threadManager.setSessionForThread(chatId, incomingThreadId, newSession.id);
              console.log(`[Message] Auto-created session ${newSession.id.substring(0, 8)}... and bound to thread ${incomingThreadId}`);

              // Send the message to the new session
              const runContext = this.buildRunContext(newSession.id, chatId, incomingThreadId, userId);
              this.trackOutgoingRun(newSession.id, text, runContext);
              this.sessionManager.sendToSession(newSession.id, text);

              // Notify the user
              await this.replyWithThreadSupport(ctx,
                `Auto-created new session for this thread.\n` +
                `Session: ${newSession.name}\n` +
                `ID: \`${newSession.id.substring(0, 8)}...\``,
                incomingThreadId,
                'Markdown'
              );
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : 'Unknown error';
              console.error(`[Message] Failed to auto-create session: ${errorMsg}`);
              await this.replyWithThreadSupport(ctx,
                `Failed to create session for this thread: ${errorMsg}\n` +
                'Use /new to create a session manually.',
                incomingThreadId
              );
              return;
            }
          }
        } else {
          // Fall back to global session behavior
          const activeSession = this.sessionManager.getActiveSession();
          if (activeSession) {
            const runContext = this.buildRunContext(activeSession.id, chatId, incomingThreadId, userId);
            this.trackOutgoingRun(activeSession.id, text, runContext);
          }
          this.sessionManager.sendToActiveSession(text);
        }

        // Provide appropriate feedback based on what was sent
        if (text.startsWith('/babysitter:call')) {
          await this.replyWithThreadSupport(ctx, 'Sent to the Babysitter.', incomingThreadId);
        } else {
          await this.replyWithThreadSupport(ctx, 'Sent to Claude session.', incomingThreadId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No active session';
        await this.replyWithThreadSupport(ctx, `Error: ${message}. Use /new to create a session.`, incomingThreadId);
      }
    });

    // Handle voice messages
    this.bot.on('voice', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Track which chat is actively communicating with the bot
      this.activeChat = chatId;

      // Check if voice is enabled for this user
      const voiceEnabled = this.userVoiceEnabled.get(userId) ?? this.voiceConfig.enabled;
      if (!voiceEnabled || !this.voiceHandler) {
        await this.replyWithThreadSupport(ctx,
          'Voice transcription is disabled.\n' +
          'Use /voice on to enable it.',
          messageThreadId
        );
        return;
      }

      try {
        await this.replyWithThreadSupport(ctx, 'Transcribing voice message...', messageThreadId);

        const voice = ctx.message.voice;
        const file = await ctx.telegram.getFile(voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;

        // Download the file as a buffer
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Transcribe
        const transcribedText = await this.voiceHandler.transcribe(buffer, voice.file_id);

        if (!transcribedText || transcribedText.trim().length === 0) {
          await this.replyWithThreadSupport(ctx, 'Could not transcribe voice message (no speech detected).', messageThreadId);
          return;
        }

        await this.replyWithThreadSupport(ctx, `Transcribed: "${transcribedText}"\n\nSending to Claude...`, messageThreadId);

        // Resolve session based on thread context
        const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx, 'No active session. Use /new to create one.', messageThreadId);
          return;
        }

        // Send to Claude session
        const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, userId);
        this.trackOutgoingRun(sessionId, transcribedText, runContext);
        this.sessionManager.sendToSession(sessionId, transcribedText);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Transcription failed';
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // Handle document uploads
    this.bot.on('document', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Track which chat is actively communicating with the bot
      this.activeChat = chatId;

      // Check if upload is enabled for this user
      const uploadEnabled = this.userUploadEnabled.get(userId) ?? this.fileUploadConfig.enabled;
      if (!uploadEnabled || !this.fileHandler) {
        await this.replyWithThreadSupport(ctx,
          'File upload is disabled.\n' +
          'Use /upload on to enable it.',
          messageThreadId
        );
        return;
      }

      try {
        const doc = ctx.message.document;
        const fileName = doc.file_name || 'unknown';
        const mimeType = doc.mime_type || 'application/octet-stream';
        const fileSize = doc.file_size || 0;

        // Validate file
        const validation = this.fileHandler.validateFile(fileName, mimeType, fileSize);
        if (!validation.valid) {
          await this.replyWithThreadSupport(ctx, `Cannot process file: ${validation.reason}`, messageThreadId);
          return;
        }

        await this.replyWithThreadSupport(ctx, `Processing file: ${fileName}...`, messageThreadId);

        // Download the file
        const file = await ctx.telegram.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Save the file
        const fileInfo = await this.fileHandler.saveFile(buffer, fileName, mimeType, doc.file_id);

        // Determine how to send to Claude
        let messageToSend: string;
        const caption = ctx.message.caption || '';

        if (this.fileHandler.isTextFile(mimeType, fileInfo.extension)) {
          // Read text content and send it
          const content = await this.fileHandler.readFileAsText(fileInfo.localPath);
          messageToSend = `File: ${fileName}\n\n\`\`\`\n${content}\n\`\`\`\n\n${caption}`.trim();
        } else if (this.fileHandler.isImage(mimeType)) {
          // For images, send the path
          messageToSend = `[Image uploaded: ${fileInfo.localPath}]\n\n${caption}`.trim();
        } else {
          // For other files, send the path
          messageToSend = `[File uploaded: ${fileInfo.localPath}]\n\n${caption}`.trim();
        }

        // Resolve session based on thread context
        const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx, 'No active session. Use /new to create one.', messageThreadId);
          return;
        }

        await this.replyWithThreadSupport(ctx, `Sending to Claude: ${fileName}`, messageThreadId);
        const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, userId);
        this.trackOutgoingRun(sessionId, messageToSend, runContext);
        this.sessionManager.sendToSession(sessionId, messageToSend);

        // Clean up the file after a delay
        setTimeout(() => {
          this.fileHandler?.deleteFile(fileInfo.localPath);
        }, 60000); // 1 minute
      } catch (error) {
        const message = error instanceof Error ? error.message : 'File processing failed';
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });

    // Handle photo uploads
    this.bot.on('photo', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const chatId = ctx.chat.id;
      const messageThreadId = this.extractThreadId(ctx.message);

      // Track which chat is actively communicating with the bot
      this.activeChat = chatId;

      // Check if upload is enabled for this user
      const uploadEnabled = this.userUploadEnabled.get(userId) ?? this.fileUploadConfig.enabled;
      if (!uploadEnabled || !this.fileHandler) {
        await this.replyWithThreadSupport(ctx,
          'File upload is disabled.\n' +
          'Use /upload on to enable it.',
          messageThreadId
        );
        return;
      }

      try {
        // Get the largest photo (last in array)
        const photos = ctx.message.photo;
        const largestPhoto = photos[photos.length - 1];

        await this.replyWithThreadSupport(ctx, 'Processing image...', messageThreadId);

        // Download the photo
        const file = await ctx.telegram.getFile(largestPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.bot.telegram.token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Determine file name and extension from file path
        const extension = file.file_path?.split('.').pop() || 'jpg';
        const fileName = `photo_${Date.now()}.${extension}`;
        const mimeType = `image/${extension === 'jpg' ? 'jpeg' : extension}`;

        // Save the file
        const fileInfo = await this.fileHandler.saveFile(buffer, fileName, mimeType, largestPhoto.file_id);

        // Send to Claude with the image path
        const caption = ctx.message.caption || 'Please analyze this image.';
        const messageToSend = `[Image uploaded: ${fileInfo.localPath}]\n\n${caption}`;

        // Resolve session based on thread context
        const { session, sessionId } = this.resolveSessionForThread(chatId, messageThreadId);
        if (!session || !sessionId) {
          await this.replyWithThreadSupport(ctx, 'No active session. Use /new to create one.', messageThreadId);
          return;
        }

        await this.replyWithThreadSupport(ctx, 'Sending image to Claude...', messageThreadId);
        const runContext = this.buildRunContext(sessionId, chatId, messageThreadId, userId);
        this.trackOutgoingRun(sessionId, messageToSend, runContext);
        this.sessionManager.sendToSession(sessionId, messageToSend);

        // Clean up the file after a delay
        setTimeout(() => {
          this.fileHandler?.deleteFile(fileInfo.localPath);
        }, 60000); // 1 minute
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Image processing failed';
        await this.replyWithThreadSupport(ctx, `Error: ${message}`, messageThreadId);
      }
    });
  }

  /**
   * Set up output forwarding from Claude sessions
   */
  private setupOutputForwarding(): void {
    // Capture raw output events for run tracking
    this.outputParser.on('output', (output) => {
      const sessionId = this.currentOutputSessionId;
      if (sessionId && this.reportingConfig.enabled) {
        this.runTracker.recordOutput(sessionId, output);
      }
    });

    this.outputParser.on('streaming_start', () => {
      const sessionId = this.currentOutputSessionId;
      if (sessionId && this.reportingConfig.enabled) {
        this.runTracker.recordEvent(sessionId, 'stream_start');
      }
    });

    this.outputParser.on('streaming_complete', (event) => {
      const sessionId = this.currentOutputSessionId;
      if (sessionId && this.reportingConfig.enabled) {
        this.runTracker.recordEvent(sessionId, 'stream_complete', `${event.durationMs}ms`);
      }
    });

    this.outputParser.on('tool_call', (tool) => {
      const sessionId = this.currentOutputSessionId;
      if (sessionId && this.reportingConfig.enabled) {
        this.runTracker.recordToolCall(sessionId, tool);
      }
    });

    // Listen for questions from OutputParser
    this.outputParser.on('question', (question: ParsedQuestion) => {
      const sessionId = this.currentOutputSessionId;
      console.log(`[OutputParser] Question event received from session ${sessionId?.substring(0, 8) || 'unknown'}:`, question.question.substring(0, 50));
      // Set per-session flag to suppress subsequent messages until user responds
      if (sessionId) {
        this.waitingForUserResponse.set(sessionId, true);
        this.suppressedMessages.set(sessionId, []); // Clear any previously suppressed messages
        if (this.reportingConfig.enabled) {
          this.runTracker.recordEvent(sessionId, 'question', question.question);
        }
      }
      this.forwardQuestionToUsers(question);
    });

    // Listen for text output (accumulated from streaming deltas)
    this.outputParser.on('text', (text: string) => {
      const sessionId = this.currentOutputSessionId;
      if (sessionId && this.reportingConfig.enabled) {
        this.runTracker.recordText(sessionId, text);
      }
      // Skip if waiting for user to respond to a question (per-session check)
      if (sessionId && this.waitingForUserResponse.get(sessionId)) {
        console.log(`[OutputParser] Suppressing text for session ${sessionId.substring(0, 8)}... while waiting for user response`);
        // Optionally buffer important messages per session
        if (text && text.trim()) {
          const buffer = this.suppressedMessages.get(sessionId) || [];
          buffer.push(text.trim());
          this.suppressedMessages.set(sessionId, buffer);
        }
        return;
      }

      // Forward assistant text messages to users
      if (text && text.trim()) {
        this.forwardTextToUsers(text);
      }
    });

    // Listen for progress events (tool executions)
    // Only show failures to reduce noise - successes are implied
    this.outputParser.on('progress', (progress: { type: string; toolName?: string; success?: boolean }) => {
      const sessionId = this.currentOutputSessionId;
      // Skip if waiting for user to respond to a question (per-session check)
      if (sessionId && this.waitingForUserResponse.get(sessionId)) {
        console.log(`[OutputParser] Suppressing progress for session ${sessionId.substring(0, 8)}... while waiting for user response`);
        return;
      }

      if (progress.type === 'tool_end' && !progress.success) {
        this.forwardProgressToUsers('❌ Tool execution failed');
      }
      // Skip tool_start and success messages to reduce noise
    });

    // Skip thinking events - they add too much noise
    // this.outputParser.on('thinking', () => { ... });

    // Skip 'started' event - the user knows they sent a message
    // this.outputParser.on('started', () => { ... });
  }

  /**
   * Subscribe to a session's output and pipe it to the OutputParser
   */
  private subscribeToSessionOutput(sessionId: string): void {
    // Unsubscribe from any previous subscription for this session
    this.unsubscribeFromSession(sessionId);

    try {
      // Get the session's process output and pipe it to the parser
      // NOTE: ClaudeCodeProcess emits lines WITHOUT trailing newlines,
      // but OutputParser.parseStreamOutput() buffers and splits by '\n',
      // so we must add the newline for lines to be processed.
      const unsubscribe = this.sessionManager.onSessionOutput(sessionId, (data: string) => {
        // Store in output history for /log command
        this.addToOutputHistory(data);

        // Check for context info in the output
        this.parseContextInfo(data);

        // Check for cost info if we're waiting for it
        if (this.pendingCostCallback && data.includes('$')) {
          this.pendingCostCallback(data);
          this.pendingCostCallback = null;
        }

        // Track which session is producing this output (for correct thread routing)
        // This must be set BEFORE parsing so forwardTextToUsers knows the source session
        this.currentOutputSessionId = sessionId;
        this.outputParser.parseStreamOutput(data + '\n');
      });
      this.outputUnsubscribers.set(sessionId, unsubscribe);

      // Subscribe to error events
      const errorUnsubscribe = this.sessionManager.onSessionError(sessionId, (error: Error) => {
        // Track which session produced this error for correct thread routing
        this.currentOutputSessionId = sessionId;
        this.forwardErrorToUsers(error.message);
      });
      this.errorUnsubscribers.set(sessionId, errorUnsubscribe);

      // Subscribe to close events with auto-reconnect notification
      const closeUnsubscribe = this.sessionManager.onSessionClose(sessionId, (code: number | null) => {
        // Track which session closed for correct thread routing
        this.currentOutputSessionId = sessionId;
        if (code !== 0 && code !== null) {
          this.forwardErrorToUsers(`Session crashed (exit code: ${code}) - use /new to restart`);
          // Auto-reconnect notification: inform user about the crash
          this.notifySessionCrash(sessionId, code);
        } else {
          this.forwardStatusToUsers('Session ended gracefully');
        }
      });
      this.closeUnsubscribers.set(sessionId, closeUnsubscribe);
    } catch (error) {
      console.error(`Failed to subscribe to session ${sessionId} output:`, error);
    }
  }

  /**
   * Add a line to output history for /log command
   */
  private addToOutputHistory(line: string): void {
    if (!line || line.trim().length === 0) return;

    this.outputHistory.push(line);

    // Keep only last N lines
    if (this.outputHistory.length > TelegramBot.MAX_OUTPUT_HISTORY) {
      this.outputHistory.shift();
    }
  }

  /**
   * Parse context information from Claude output
   */
  private parseContextInfo(text: string): void {
    // Look for context usage patterns like "Context: 45,000 tokens (23%)"
    const contextMatch = text.match(/context[:\s]+([\d,]+)\s*tokens?\s*\(?([\d.]+)?%?\)?/i);
    if (contextMatch) {
      this.lastContextInfo = {
        tokens: parseInt(contextMatch[1].replace(/,/g, ''), 10),
        percentage: contextMatch[2] ? parseFloat(contextMatch[2]) : undefined,
        timestamp: new Date(),
      };
    }
  }

  private buildRunContext(sessionId: string, chatId?: number, threadId?: number, userId?: number): RunContext {
    const session = this.sessionManager.getSession(sessionId);
    return {
      chatId,
      threadId,
      userId,
      sessionName: session?.name,
      workingDir: session?.workingDir,
    };
  }

  private resolveRunType(input: string): 'babysitter' | 'general' {
    const normalized = input.trim().toLowerCase();
    if (normalized.startsWith('/babysitter:call') || normalized.startsWith('/babysit')) {
      return 'babysitter';
    }
    return 'general';
  }

  private parseCommandArgs(text: string, command: string): string[] {
    const pattern = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, 'i');
    const rawArgs = text.replace(pattern, '').trim();
    if (!rawArgs) return [];

    const tokens = rawArgs.match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\\S+/g) ?? [];
    return tokens.map((token) => {
      if (
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))
      ) {
        return token.slice(1, -1).replace(/\\(["'\\])/g, '$1');
      }
      return token;
    });
  }

  private parseReportHistoryArgs(args: string[]): {
    projectPath?: string;
    runIndex: number;
    sessionIdPrefix?: string;
    includeGeneral: boolean;
    error?: string;
  } {
    let projectPath: string | undefined;
    let runIndex = 1;
    let sessionIdPrefix: string | undefined;
    let includeGeneral = false;

    const positionals: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--all') {
        includeGeneral = true;
        continue;
      }

      if (arg === '--index') {
        const value = args[i + 1];
        if (!value) {
          return { runIndex, includeGeneral, error: 'Missing value for --index.' };
        }
        const parsed = parseInt(value, 10);
        if (Number.isNaN(parsed) || parsed < 1) {
          return { runIndex, includeGeneral, error: '--index must be a positive number.' };
        }
        runIndex = parsed;
        i += 1;
        continue;
      }

      if (arg.startsWith('--index=')) {
        const parsed = parseInt(arg.slice('--index='.length), 10);
        if (Number.isNaN(parsed) || parsed < 1) {
          return { runIndex, includeGeneral, error: '--index must be a positive number.' };
        }
        runIndex = parsed;
        continue;
      }

      if (arg === '--session') {
        const value = args[i + 1];
        if (!value) {
          return { runIndex, includeGeneral, error: 'Missing value for --session.' };
        }
        sessionIdPrefix = value;
        i += 1;
        continue;
      }

      if (arg.startsWith('--session=')) {
        sessionIdPrefix = arg.slice('--session='.length);
        continue;
      }

      positionals.push(arg);
    }

    if (positionals[0]) {
      projectPath = positionals[0];
    }

    if (positionals[1]) {
      const maybeIndex = parseInt(positionals[1], 10);
      if (!Number.isNaN(maybeIndex) && maybeIndex > 0) {
        runIndex = maybeIndex;
      } else if (!sessionIdPrefix) {
        sessionIdPrefix = positionals[1];
      }
    }

    if (positionals[2] && !sessionIdPrefix) {
      sessionIdPrefix = positionals[2];
    }

    return {
      projectPath,
      runIndex,
      sessionIdPrefix,
      includeGeneral,
    };
  }

  private trackOutgoingRun(sessionId: string, input: string, context: RunContext, isFollowup: boolean = false): void {
    if (!this.reportingConfig.enabled) return;
    if (isFollowup) {
      this.runTracker.appendUserMessage(sessionId, input, context);
    } else {
      this.runTracker.startTypedRun(sessionId, input, this.resolveRunType(input), context);
    }
  }

  private async sendRunReport(run: RunRecord): Promise<void> {
    const chatId = run.context?.chatId ?? this.activeChat ?? Array.from(this.userChatIds.values())[0];
    if (!chatId) {
      console.warn('[Report] No chat available to send run report');
      return;
    }

    const threadId = run.context?.threadId;
    let html = ReportGenerator.generateHtml(run, { maxOutputChars: this.reportingConfig.maxOutputChars });
    let bytes = Buffer.byteLength(html, 'utf8');
    const maxBytes = this.reportingConfig.maxFileSizeMB * 1024 * 1024;

    if (bytes > maxBytes) {
      html = ReportGenerator.generateHtml(run, { maxOutputChars: Math.min(2000, this.reportingConfig.maxOutputChars) });
      bytes = Buffer.byteLength(html, 'utf8');
    }

    if (this.reportingConfig.previewDir) {
      await this.saveRunReportPreview(run.id, html);
    }

    if (bytes > maxBytes) {
      await this.bot.telegram.sendMessage(
        chatId,
        `Run report ${run.id} is too large to send (${(bytes / (1024 * 1024)).toFixed(1)}MB).`,
        threadId ? { message_thread_id: threadId } : undefined
      );
      return;
    }

    const fileName = `run-${run.id}.html`;
    const filePath = path.join(os.tmpdir(), fileName);
    await fs.promises.writeFile(filePath, html, 'utf8');

    try {
      try {
        await this.bot.telegram.sendDocument(
          chatId,
          { source: fs.createReadStream(filePath), filename: fileName },
          threadId ? { message_thread_id: threadId, caption: `Run report ${run.id}` } : { caption: `Run report ${run.id}` }
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isThreadError = errorMessage.toLowerCase().includes('thread') ||
          errorMessage.toLowerCase().includes('topic') ||
          errorMessage.includes('MESSAGE_THREAD_INVALID');
        if (threadId && isThreadError) {
          await this.bot.telegram.sendDocument(
            chatId,
            { source: fs.createReadStream(filePath), filename: fileName },
            { caption: `Run report ${run.id}` }
          );
        } else {
          throw error;
        }
      }
    } finally {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }

  private async saveRunReportPreview(runId: string, html: string): Promise<void> {
    if (!this.reportingConfig.previewDir) return;
    const dir = path.resolve(this.reportingConfig.previewDir);
    const filePath = path.join(dir, `run-${runId}.html`);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(filePath, html, 'utf8');
      console.log(`[Report] Saved local preview: ${filePath}`);
    } catch (error) {
      console.error('[Report] Failed to save local preview file:', error);
    }
  }

  /**
   * Notify users about session crash (auto-reconnect feature)
   */
  private async notifySessionCrash(sessionId: string, exitCode: number): Promise<void> {
    const session = this.sessionManager.getSession(sessionId);
    const sessionName = session?.name || sessionId;

    const message = `🔄 Session "${sessionName}" crashed (exit code: ${exitCode}).\n\n` +
      `Options:\n` +
      `• /new ${sessionName} - Create new session\n` +
      `• /sessions - View and attach to existing Claude sessions`;

    for (const [_userId, chatId] of this.userChatIds.entries()) {
      try {
        await this.bot.telegram.sendMessage(chatId, message);
      } catch (error) {
        console.error(`Failed to send crash notification to chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Unsubscribe from a session's output
   */
  private unsubscribeFromSession(sessionId: string): void {
    const unsubscribe = this.outputUnsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.outputUnsubscribers.delete(sessionId);
    }

    const errorUnsubscribe = this.errorUnsubscribers.get(sessionId);
    if (errorUnsubscribe) {
      errorUnsubscribe();
      this.errorUnsubscribers.delete(sessionId);
    }

    const closeUnsubscribe = this.closeUnsubscribers.get(sessionId);
    if (closeUnsubscribe) {
      closeUnsubscribe();
      this.closeUnsubscribers.delete(sessionId);
    }

    // Clear session-to-thread mapping when session is unsubscribed
    // Use ThreadManager for cleanup if available
    if (this.threadManager) {
      this.threadManager.unmapSession(sessionId);
    }
  }

  /**
   * Forward text output to all connected users with message batching
   * If activeChat is set, prioritize sending to that chat (group support)
   * Uses session thread mapping to route output to the correct thread
   */
  private async forwardTextToUsers(text: string): Promise<void> {

    // Skip empty or very short messages
    if (!text || text.trim().length === 0) {
      return;
    }

    // Get thread context from the session that PRODUCED this output (not the global active session)
    // This is critical for correct routing when multiple sessions are active
    let sessionThreadId: number | undefined;
    let sessionChatId: number | string | undefined;
    const outputSessionId = this.currentOutputSessionId;
    const outputSession = outputSessionId ? this.sessionManager.getSession(outputSessionId) : null;

    console.log(`[ForwardText] OUTPUT ROUTING: currentOutputSessionId=${outputSessionId?.substring(0, 8) || 'null'}, text="${text.substring(0, 50)}..."`);
    console.log(`[ForwardText] Global active session: ${this.sessionManager.getActiveSession()?.id.substring(0, 8) || 'none'}`);

    if (outputSession && outputSessionId) {
      console.log(`[ForwardText] Looking up thread for output session ${outputSessionId.substring(0, 8)}...`);
      const sessionThread = this.threadManager?.getThreadForSession(outputSessionId);
      if (sessionThread) {
        sessionThreadId = sessionThread.threadId;
        sessionChatId = sessionThread.chatId;
        console.log(`[ForwardText] FOUND: Output session ${outputSessionId.substring(0, 8)}... -> thread ${sessionThreadId} in chat ${sessionChatId}`);
      } else {
        console.log(`[ForwardText] NOT FOUND: Output session ${outputSessionId.substring(0, 8)}... has no thread binding`);
      }
    } else {
      // Fallback to global active session if no output session is tracked
      const activeSession = this.sessionManager.getActiveSession();
      if (activeSession) {
        const sessionThread = this.threadManager?.getThreadForSession(activeSession.id);
        if (sessionThread) {
          sessionThreadId = sessionThread.threadId;
          sessionChatId = sessionThread.chatId;
          console.log(`[ForwardText] Fallback to active session ${activeSession.id.substring(0, 8)}... bound to thread ${sessionThreadId}`);
        } else {
          console.log(`[ForwardText] Active session ${activeSession.id.substring(0, 8)}... has no thread binding`);
        }
      } else {
        console.log(`[ForwardText] No session for text forwarding`);
      }
    }

    // Build list of chats to send to
    const chatsToNotify = new Set<number>();

    // If there's an active chat (from a recent message), prioritize it
    if (this.activeChat !== null) {
      chatsToNotify.add(this.activeChat);
    }

    // Also include all user chats for multi-user support
    for (const [_userId, chatId] of this.userChatIds.entries()) {
      chatsToNotify.add(chatId);
    }

    console.log(`[ForwardText] Will notify ${chatsToNotify.size} chat(s): ${Array.from(chatsToNotify).join(', ')}`);

    for (const chatId of chatsToNotify) {
      try {
        // Find the user for this chat to check preferences
        let userId: number | undefined;
        for (const [uid, cid] of this.userChatIds.entries()) {
          if (cid === chatId) {
            userId = uid;
            break;
          }
        }

        if (userId) {
          // Check verbosity - minimal level skips text output
          const verbosity = this.userVerbosityLevel.get(userId) ?? this.defaultVerbosity;
          if (verbosity === 'minimal') {
            console.log(`[ForwardText] Skipping chat ${chatId} (user ${userId} has minimal verbosity)`);
            continue;
          }

          // Check notification preferences
          const prefs = this.userNotificationPrefs.get(userId) ?? this.defaultNotificationPrefs;
          if (!prefs.completion) {
            console.log(`[ForwardText] Skipping chat ${chatId} (user ${userId} has completion notifications disabled)`);
            continue;
          }
        }

        // Determine thread ID: prefer session thread (for matching chat), then user preference
        let threadId: number | undefined;
        if (sessionThreadId !== undefined && sessionChatId === chatId) {
          threadId = sessionThreadId;
          console.log(`[ForwardText] Using session thread binding: threadId=${threadId} for chatId=${chatId}`);
        } else if (userId && this.isThreadedModeEnabledForUser(userId)) {
          threadId = this.getUserThreadId(chatId, userId);
          if (threadId !== undefined) {
            console.log(`[ForwardText] Using user thread preference: threadId=${threadId} for chatId=${chatId}, userId=${userId}`);
          }
        }

        if (threadId === undefined) {
          console.log(`[ForwardText] No thread binding, routing to main chat: chatId=${chatId}`);
        }

        // Use message batching to reduce message spam (with thread support)
        this.batchMessage(chatId, text, userId, threadId);
      } catch (error) {
        console.error(`[ForwardText] Failed to queue text for chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Add message to batch buffer and schedule flush (with thread support)
   * @param chatId - The chat ID to send to
   * @param text - The message text
   * @param userId - Optional user ID for thread context lookup
   * @param threadId - Optional explicit thread ID override
   */
  private batchMessage(chatId: number, text: string, userId?: number, threadId?: number): void {
    // Create a batch key that includes thread context
    const batchKey = threadId !== undefined ? `${chatId}:${threadId}` : `${chatId}`;

    console.log(`[BatchMessage] Adding message to batch: chatId=${chatId}, threadId=${threadId}, batchKey=${batchKey}`);

    // Get or create buffer for this chat/thread combination
    if (!this.messageBatchBuffer.has(batchKey)) {
      this.messageBatchBuffer.set(batchKey, { messages: [], userId, threadId });
      console.log(`[BatchMessage] Created new batch buffer for key=${batchKey}`);
    }
    const batchContext = this.messageBatchBuffer.get(batchKey)!;
    batchContext.messages.push(text);

    // Clear existing timer if any
    const existingTimer = this.messageBatchTimer.get(batchKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set timer to flush buffer
    const timer = setTimeout(() => {
      this.flushMessageBatch(chatId, batchKey);
    }, TelegramBot.BATCH_DELAY_MS);
    this.messageBatchTimer.set(batchKey, timer);
  }

  /**
   * Flush batched messages for a chat (with thread support)
   * @param chatId - The chat ID
   * @param batchKey - The batch key (chatId or chatId:threadId)
   */
  private async flushMessageBatch(chatId: number, batchKey?: string): Promise<void> {
    const effectiveKey = batchKey ?? `${chatId}`;
    const batchContext = this.messageBatchBuffer.get(effectiveKey);
    if (!batchContext || batchContext.messages.length === 0) return;

    console.log(`[FlushBatch] Flushing batch: chatId=${chatId}, batchKey=${effectiveKey}, threadId=${batchContext.threadId}, messageCount=${batchContext.messages.length}`);

    // Clear buffer and timer
    this.messageBatchBuffer.delete(effectiveKey);
    this.messageBatchTimer.delete(effectiveKey);

    // Combine messages
    const combined = batchContext.messages.join('\n');

    // Truncate if too long
    const maxLength = 4000;
    const truncatedText = combined.length > maxLength
      ? combined.slice(0, maxLength) + '\n...(truncated)'
      : combined;

    // Check rate limit
    const lastTime = this.lastMessageTime.get(chatId) || 0;
    const now = Date.now();
    const timeSinceLast = now - lastTime;

    if (timeSinceLast < TelegramBot.RATE_LIMIT_MS) {
      // Queue the message for later (with thread context)
      console.log(`[FlushBatch] Rate limited, queueing message for chatId=${chatId}, threadId=${batchContext.threadId}`);
      this.queueMessage(chatId, truncatedText, batchContext.userId, batchContext.threadId);
      return;
    }

    // Send immediately (with thread context)
    console.log(`[FlushBatch] Sending immediately to chatId=${chatId}, threadId=${batchContext.threadId}`);
    await this.sendMessageWithRateLimit(chatId, truncatedText, batchContext.userId, batchContext.threadId);
  }

  /**
   * Queue a message for later sending (when rate limited, with thread support)
   * @param chatId - The chat ID
   * @param message - The message text
   * @param userId - Optional user ID for thread context
   * @param threadId - Optional explicit thread ID
   */
  private queueMessage(chatId: number, message: string, userId?: number, threadId?: number): void {
    // Don't queue if already at max
    if (this.messageQueue.length >= TelegramBot.MAX_QUEUE_SIZE) {
      console.warn(`Message queue full, dropping message for chat ${chatId}`);
      return;
    }

    this.messageQueue.push({ chatId, message, timestamp: Date.now(), userId, threadId });

    // Start processing queue if not already
    if (!this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  /**
   * Process queued messages respecting rate limits (with thread support)
   */
  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift()!;
      const lastTime = this.lastMessageTime.get(item.chatId) || 0;
      const now = Date.now();
      const timeSinceLast = now - lastTime;

      if (timeSinceLast < TelegramBot.RATE_LIMIT_MS) {
        // Wait for rate limit to clear
        const waitTime = TelegramBot.RATE_LIMIT_MS - timeSinceLast;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      await this.sendMessageWithRateLimit(item.chatId, item.message, item.userId, item.threadId);
    }

    this.isProcessingQueue = false;
  }

  /**
   * Send message and track rate limit (supports threaded mode)
   * @param chatId - The chat ID
   * @param text - The message text
   * @param userId - Optional user ID for thread context lookup
   * @param explicitThreadId - Optional explicit thread ID (takes precedence over user preference)
   */
  private async sendMessageWithRateLimit(chatId: number, text: string, userId?: number, explicitThreadId?: number): Promise<void> {
    try {
      const options: { message_thread_id?: number } = {};

      // Priority 1: Use explicit thread ID if provided
      if (explicitThreadId !== undefined) {
        options.message_thread_id = explicitThreadId;
        console.log(`[Routing] Using explicit threadId=${explicitThreadId} for chatId=${chatId}`);
      } else {
        // Priority 2: Check for session-based thread mapping (via ThreadManager)
        const activeSession = this.sessionManager.getActiveSession();
        if (activeSession) {
          const sessionThread = this.threadManager?.getThreadForSession(activeSession.id);
          if (sessionThread && sessionThread.chatId === chatId) {
            options.message_thread_id = sessionThread.threadId;
            console.log(`[Routing] Using session thread binding: sessionId=${activeSession.id}, threadId=${sessionThread.threadId}, chatId=${chatId}`);
          } else if (sessionThread) {
            console.log(`[Routing] Session thread exists but chatId mismatch: expected=${sessionThread.chatId}, actual=${chatId}`);
          }
        }

        // Priority 3: Fall back to user preference for threaded mode
        if (options.message_thread_id === undefined && userId && this.isThreadedModeEnabledForUser(userId)) {
          const threadId = this.getUserThreadId(chatId, userId);
          if (threadId !== undefined) {
            options.message_thread_id = threadId;
            console.log(`[Routing] Using user threaded mode preference: userId=${userId}, threadId=${threadId}, chatId=${chatId}`);
          }
        }
      }

      if (options.message_thread_id === undefined) {
        console.log(`[Routing] No thread binding found, sending to main chat: chatId=${chatId}`);
      }

      await this.bot.telegram.sendMessage(chatId, text, options);
      this.lastMessageTime.set(chatId, Date.now());
    } catch (error) {
      console.error(`[Routing] Failed to send message to chat ${chatId}:`, error);
    }
  }

  /**
   * Forward error messages to all connected users with emoji indicator
   */
  private async forwardErrorToUsers(errorMessage: string): Promise<void> {
    if (!errorMessage || errorMessage.trim().length === 0) {
      return;
    }

    const formattedError = `⚠️ ${errorMessage}`;

    for (const [userId, chatId] of this.userChatIds.entries()) {
      try {
        // Check notification preferences
        const prefs = this.userNotificationPrefs.get(userId) ?? this.defaultNotificationPrefs;
        if (!prefs.error) {
          continue;
        }

        await this.bot.telegram.sendMessage(chatId, formattedError);
      } catch (error) {
        console.error(`Failed to send error to chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Forward status messages to all connected users with emoji indicator
   */
  private async forwardStatusToUsers(statusMessage: string): Promise<void> {
    if (!statusMessage || statusMessage.trim().length === 0) {
      return;
    }

    const formattedStatus = `ℹ️ ${statusMessage}`;

    for (const [_userId, chatId] of this.userChatIds.entries()) {
      try {
        await this.bot.telegram.sendMessage(chatId, formattedStatus);
      } catch (error) {
        console.error(`Failed to send status to chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Forward progress messages to all connected users (tool execution progress)
   */
  private async forwardProgressToUsers(progressMessage: string): Promise<void> {
    if (!progressMessage || progressMessage.trim().length === 0) {
      return;
    }

    for (const [userId, chatId] of this.userChatIds.entries()) {
      try {
        // Check verbosity - only verbose level shows progress
        const verbosity = this.userVerbosityLevel.get(userId) ?? this.defaultVerbosity;
        if (verbosity !== 'verbose') {
          continue;
        }

        // Check notification preferences
        const prefs = this.userNotificationPrefs.get(userId) ?? this.defaultNotificationPrefs;
        if (!prefs.progress) {
          continue;
        }

        await this.bot.telegram.sendMessage(chatId, progressMessage);
      } catch (error) {
        console.error(`Failed to send progress to chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Forward a question to all connected users (including active group chat)
   * Routes to correct thread if session is bound to a thread
   */
  private async forwardQuestionToUsers(question: ParsedQuestion): Promise<void> {
    console.log(`[Question] Detected question: "${question.question.substring(0, 50)}..."`);
    console.log(`[Question] Connected users: ${this.userChatIds.size}, Active chat: ${this.activeChat}`);

    // Get thread context from the session that PRODUCED this output (not the global active session)
    // This is critical for correct routing when multiple sessions are active in different threads
    let sessionThreadId: number | undefined;
    let sessionChatId: number | string | undefined;
    const outputSessionId = this.currentOutputSessionId;
    const outputSession = outputSessionId ? this.sessionManager.getSession(outputSessionId) : null;

    // Determine the session ID to store with this question for answer routing
    // This is CRITICAL: answers must go back to the session that asked the question
    let questionSessionId: string | null = outputSessionId;

    console.log(`[Question] OUTPUT ROUTING: currentOutputSessionId=${outputSessionId?.substring(0, 8) || 'null'}`);
    console.log(`[Question] Global active session: ${this.sessionManager.getActiveSession()?.id.substring(0, 8) || 'none'}`);

    if (outputSession && outputSessionId) {
      console.log(`[Question] Looking up thread for output session ${outputSessionId.substring(0, 8)}...`);
      const sessionThread = this.threadManager?.getThreadForSession(outputSessionId);
      if (sessionThread) {
        sessionThreadId = sessionThread.threadId;
        sessionChatId = sessionThread.chatId;
        console.log(`[Question] FOUND: Output session ${outputSessionId.substring(0, 8)}... -> thread ${sessionThreadId} in chat ${sessionChatId}`);
      } else {
        console.log(`[Question] NOT FOUND: Output session ${outputSessionId.substring(0, 8)}... has no thread binding`);
      }
    } else {
      // Fallback to global active session if no output session is tracked
      const activeSession = this.sessionManager.getActiveSession();
      if (activeSession) {
        questionSessionId = activeSession.id; // Use fallback session for answer routing
        const sessionThread = this.threadManager?.getThreadForSession(activeSession.id);
        if (sessionThread) {
          sessionThreadId = sessionThread.threadId;
          sessionChatId = sessionThread.chatId;
          console.log(`[Question] Fallback to active session ${activeSession.id.substring(0, 8)}... bound to thread ${sessionThreadId}`);
        } else {
          console.log(`[Question] Active session ${activeSession.id.substring(0, 8)}... has no thread binding`);
        }
      } else {
        console.log(`[Question] No session for question forwarding`);
      }
    }

    // If we don't have a session ID, we can't route answers properly
    if (!questionSessionId) {
      console.error(`[Question] CRITICAL: No session ID available to track question for answer routing!`);
      return;
    }

    // Build list of chats to send to
    const chatsToNotify = new Set<number>();

    // If there's an active chat (from a recent message), prioritize it
    if (this.activeChat !== null) {
      chatsToNotify.add(this.activeChat);
    }

    // Also include all user chats
    for (const [_userId, chatId] of this.userChatIds.entries()) {
      chatsToNotify.add(chatId);
    }

    if (chatsToNotify.size === 0) {
      console.warn('[Question] No chats to receive the question!');
      return;
    }

    const formatted = this.outputParser.formatForTelegram(question);

    for (const chatId of chatsToNotify) {
      try {
        // Determine thread ID: use session thread binding if chat matches
        let threadId: number | undefined;
        if (sessionThreadId !== undefined && sessionChatId === chatId) {
          threadId = sessionThreadId;
          console.log(`[Question] Routing to thread ${threadId} for chat ${chatId} (session binding)`);
        } else {
          // Fall back to user thread preference
          for (const [uid, cid] of this.userChatIds.entries()) {
            if (cid === chatId && this.isThreadedModeEnabledForUser(uid)) {
              threadId = this.getUserThreadId(chatId, uid);
              if (threadId !== undefined) {
                console.log(`[Question] Routing to thread ${threadId} for chat ${chatId} (user preference)`);
              }
              break;
            }
          }
        }

        console.log(`[Question] Sending to chat ${chatId}, threadId=${threadId}, storing sessionId=${questionSessionId.substring(0, 8)}...`);
        // Store pending question for this chat WITH the session ID that asked it
        // This ensures answers are routed back to the correct session
        this.pendingQuestions.set(chatId, { question, sessionId: questionSessionId });

        const sendOptions: {
          parse_mode?: 'Markdown' | 'HTML';
          reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          message_thread_id?: number;
        } = {
          parse_mode: formatted.parseMode,
          reply_markup: formatted.replyMarkup,
        };
        if (threadId !== undefined) {
          sendOptions.message_thread_id = threadId;
        }

        await this.bot.telegram.sendMessage(chatId, formatted.text, sendOptions);
        console.log(`[Question] Successfully sent to chat ${chatId}, threadId=${threadId}`);
      } catch (error) {
        console.error(`[Question] Failed to send question to chat ${chatId}:`, error);
      }
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    console.log('Starting Telegram bot...');
    await this.bot.launch();

    // Get bot info for mention detection in group chats
    try {
      const botInfo = await this.bot.telegram.getMe();
      this.botUsername = botInfo.username || null;
      console.log(`Telegram bot started successfully (username: @${this.botUsername})`);
    } catch {
      // In test environment, getMe might not be mocked
      console.log('Telegram bot started successfully');
    }

    // Register commands with Telegram (for command menu suggestions)
    if (this.commandRegistrationService) {
      await this.commandRegistrationService.registerAllCommands();
    }

    // Enable graceful stop
    process.once('SIGINT', () => this.stop());
    process.once('SIGTERM', () => this.stop());
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    console.log('Stopping Telegram bot...');

    // Cleanup command registration service
    if (this.commandRegistrationService) {
      this.commandRegistrationService.cleanup();
    }

    // Close all sessions
    const sessions = this.sessionManager.listSessions();
    for (const session of sessions) {
      try {
        await this.sessionManager.closeSession(session.id);
      } catch (error) {
        console.error(`Error closing session ${session.id}:`, error);
      }
    }

    this.bot.stop('SIGTERM');
    console.log('Telegram bot stopped');
  }

  /**
   * Get the underlying Telegraf instance (for testing)
   */
  getBot(): Telegraf {
    return this.bot;
  }

  /**
   * Get the session manager (for testing)
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get the output parser (for testing)
   */
  getOutputParser(): OutputParser {
    return this.outputParser;
  }

  /**
   * Check if a user is authorized
   */
  isUserAuthorized(userId: number): boolean {
    return this.allowedUsers.has(userId);
  }

  // ============================================================================
  // Streaming Mode Helper Methods
  // ============================================================================

  /**
   * Get the streaming mode for a user
   * @param userId - The user ID
   * @returns The streaming mode (defaults to config mode or 'off')
   */
  getUserStreamingMode(userId: number): StreamingMode {
    return this.userStreamingMode.get(userId) ?? this.streamingConfig.mode;
  }

  /**
   * Set the streaming mode for a user
   * @param userId - The user ID
   * @param mode - The streaming mode to set
   */
  setUserStreamingMode(userId: number, mode: StreamingMode): void {
    this.userStreamingMode.set(userId, mode);
  }

  /**
   * Check if streaming is enabled for a user
   * @param userId - The user ID
   * @returns true if streaming is enabled for this user
   */
  isStreamingEnabledForUser(userId: number): boolean {
    if (!this.streamingService || !this.streamingConfig.enabled) {
      return false;
    }
    const userMode = this.getUserStreamingMode(userId);
    return userMode !== 'off';
  }

  /**
   * Get the streaming service instance (for testing)
   */
  getStreamingService(): StreamingService | null {
    return this.streamingService;
  }

  /**
   * Get the draft handler instance (for testing)
   */
  getDraftHandler(): DraftMessageHandler | null {
    return this.draftHandler;
  }

  // ============================================================================
  // Threaded Mode Helper Methods
  // ============================================================================

  /**
   * Get the thread ID for a chat/user combination
   * @param chatId - The chat ID
   * @param userId - Optional user ID for user-specific threads
   * @returns The thread ID or undefined if not in threaded mode
   */
  getUserThreadId(chatId: number | string, userId?: number): number | undefined {
    if (!this.threadManager || !this.threadedModeConfig.enabled) {
      return undefined;
    }
    return this.threadManager.getThreadId(chatId, userId);
  }

  /**
   * Set the thread for a user in a chat
   * @param chatId - The chat ID
   * @param userId - The user ID
   * @param threadId - The thread ID to set
   */
  setUserThread(chatId: number | string, userId: number, threadId: number): void {
    if (!this.threadManager) {
      return;
    }
    this.threadManager.setThread(chatId, threadId, userId);
  }

  /**
   * Check if threaded mode is enabled for a user
   * @param userId - The user ID
   * @returns true if threaded mode is enabled
   */
  isThreadedModeEnabledForUser(userId: number): boolean {
    return this.userThreadedMode.get(userId) ?? this.threadedModeConfig.enabled;
  }

  /**
   * Set threaded mode for a user
   * @param userId - The user ID
   * @param enabled - Whether to enable threaded mode
   */
  setUserThreadedMode(userId: number, enabled: boolean): void {
    this.userThreadedMode.set(userId, enabled);
  }

  /**
   * Resolve the active session based on thread context.
   * In threaded mode, returns the session bound to the current thread.
   * Falls back to global active session if not in threaded mode or no thread binding exists.
   *
   * @param chatId - The chat ID
   * @param threadId - Optional thread ID (from message_thread_id)
   * @returns Object containing the session (or null), session ID, and source info
   */
  resolveSessionForThread(chatId: number, threadId?: number): {
    session: Session | null;
    sessionId: string | null;
    source: 'thread-bound' | 'global' | 'none';
  } {
    // In threaded mode, try to get the session bound to this thread
    if (this.threadedModeConfig.enabled && this.threadManager && threadId !== undefined) {
      const boundSessionId = this.threadManager.getSessionForThread(chatId, threadId);
      if (boundSessionId) {
        const session = this.sessionManager.getSession(boundSessionId);
        if (session) {
          return { session, sessionId: boundSessionId, source: 'thread-bound' };
        }
        // Session was deleted but mapping remains - clean it up
        this.threadManager.clearSessionForThread(chatId, threadId);
      }
      // In strict threaded mode, don't fall back to global session
      // Each thread should have its own session
      return { session: null, sessionId: null, source: 'none' };
    }

    // Fall back to global active session (non-threaded mode)
    const globalSession = this.sessionManager.getActiveSession();
    if (globalSession) {
      return { session: globalSession, sessionId: globalSession.id, source: 'global' };
    }

    return { session: null, sessionId: null, source: 'none' };
  }

  /**
   * Extract SessionContext from a Telegraf context
   * Used for thread-aware session resolution
   * @param ctx - The Telegraf context
   * @returns SessionContext with chatId, threadId, and userId
   */
  private getSessionContext(ctx: { chat?: { id: number }; message?: { message_thread_id?: number }; from?: { id: number } }): SessionContext {
    return {
      chatId: ctx.chat?.id ?? 0,
      threadId: ctx.message?.message_thread_id,
      userId: ctx.from?.id,
    };
  }

  /**
   * Get the thread manager instance (for testing)
   */
  getThreadManager(): ThreadManager | null {
    return this.threadManager;
  }

  /**
   * Get the topic handler instance (for testing)
   */
  getTopicHandler(): TopicHandler | null {
    return this.topicHandler;
  }

  /**
   * Extract thread ID from an incoming message
   * @param message - The Telegram message object
   * @returns The thread ID if present
   */
  private extractThreadId(message: { message_thread_id?: number }): number | undefined {
    return message.message_thread_id;
  }

  /**
   * Reply to a message with thread support
   * @param ctx - The Telegraf context
   * @param text - The message text
   * @param threadId - Optional thread ID to reply in
   * @param parseMode - Optional parse mode for formatting (Markdown or HTML)
   */
  private async replyWithThreadSupport(
    ctx: { reply: (text: string, extra?: { message_thread_id?: number; parse_mode?: 'Markdown' | 'HTML' }) => Promise<unknown> },
    text: string,
    threadId?: number,
    parseMode?: 'Markdown' | 'HTML'
  ): Promise<void> {
    const options: { message_thread_id?: number; parse_mode?: 'Markdown' | 'HTML' } = {};
    if (threadId !== undefined) {
      options.message_thread_id = threadId;
    }
    if (parseMode) {
      options.parse_mode = parseMode;
    }

    console.log(`[Threads] replyWithThreadSupport called: threadId=${threadId}, parseMode=${parseMode}`);

    try {
      await ctx.reply(text, options);
      console.log(`[Threads] Successfully replied with threadId=${threadId}`);
    } catch (error) {
      // Log the actual error message for debugging
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Threads] Failed to reply with thread support (threadId=${threadId}):`, errorMessage);

      // Only fall back to non-threaded reply if error indicates thread doesn't exist
      // Common Telegram API errors for invalid thread: "message thread not found", "TOPIC_CLOSED", "TOPIC_DELETED"
      const isThreadError = errorMessage.toLowerCase().includes('thread') ||
                           errorMessage.toLowerCase().includes('topic') ||
                           errorMessage.includes('MESSAGE_THREAD_INVALID');

      if (isThreadError && threadId !== undefined) {
        console.log(`[Threads] Thread error detected, falling back to non-threaded reply`);
        try {
          await ctx.reply(text, parseMode ? { parse_mode: parseMode } : undefined);
          console.log(`[Threads] Fallback reply succeeded`);
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error(`[Threads] Fallback reply also failed:`, fallbackMessage);
        }
      } else {
        // Non-thread related error - don't silently swallow it, try fallback but log prominently
        console.error(`[Threads] NON-THREAD ERROR - this may indicate a bug:`, errorMessage);
        try {
          await ctx.reply(text, parseMode ? { parse_mode: parseMode } : undefined);
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error(`[Threads] Fallback reply also failed:`, fallbackMessage);
        }
      }
    }
  }

  // ============================================================================
  // REMOVED DEPRECATED METHODS (Consolidated into ThreadManager)
  // ============================================================================
  // The following methods have been removed as session-to-thread mapping
  // is now handled exclusively by ThreadManager:
  //
  // - mapSessionToThread(sessionId, chatId, threadId): Use threadManager.setSessionForThread()
  // - getSessionThreadMapping(sessionId): Use threadManager.getThreadForSession()
  // - clearSessionThreadMapping(sessionId): Use threadManager.unmapSession()
  //
  // The private sessionThreadMapping Map has also been removed.
  // ============================================================================
}
