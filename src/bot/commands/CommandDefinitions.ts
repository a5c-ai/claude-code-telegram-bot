/**
 * Command Definitions for Telegram Bot
 *
 * Defines all bot commands with their metadata for registration with Telegram's
 * setMyCommands API. Commands are categorized and scoped for context-aware menus.
 */

/**
 * Command categories for logical grouping
 */
export enum CommandCategory {
  /** Commands for creating, listing, switching, and closing sessions */
  SessionManagement = 'SessionManagement',
  /** Commands for interacting with an active session */
  SessionInteraction = 'SessionInteraction',
  /** General utility commands */
  Utility = 'Utility',
  /** Settings and configuration commands */
  Settings = 'Settings',
  /** Commands specific to threaded/forum mode in groups */
  ThreadedMode = 'ThreadedMode',
}

/**
 * Scopes where commands should appear
 */
export enum CommandScope {
  /** Default commands shown to all users in all chats */
  Default = 'Default',
  /** Commands shown in private (1:1) chats with the bot */
  PrivateChats = 'PrivateChats',
  /** Commands shown in group chats */
  GroupChats = 'GroupChats',
  /** Commands shown when user has an active session in the chat */
  ChatWithSession = 'ChatWithSession',
}

/**
 * Definition of a bot command with metadata
 */
export interface BotCommandDefinition {
  /** Command name without the leading slash */
  command: string;
  /** Description shown in Telegram command menu (max 256 characters) */
  description: string;
  /** Category for logical grouping */
  category: CommandCategory;
  /** Scopes where this command should appear */
  scopes: CommandScope[];
}

/**
 * All bot command definitions with metadata
 */
export const COMMAND_DEFINITIONS: BotCommandDefinition[] = [
  // ============================================================================
  // Session Management Commands
  // ============================================================================
  {
    command: 'start',
    description: 'Start the bot and show welcome message',
    category: CommandCategory.Utility,
    scopes: [CommandScope.Default, CommandScope.PrivateChats, CommandScope.GroupChats],
  },
  {
    command: 'help',
    description: 'Show all available commands',
    category: CommandCategory.Utility,
    scopes: [CommandScope.Default, CommandScope.PrivateChats, CommandScope.GroupChats],
  },
  {
    command: 'new',
    description: 'Create a new Claude session',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.Default, CommandScope.PrivateChats, CommandScope.GroupChats],
  },
  {
    command: 'list',
    description: 'List active sessions',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.PrivateChats, CommandScope.GroupChats, CommandScope.ChatWithSession],
  },
  {
    command: 'sessions',
    description: 'List all Claude sessions on system',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.Default, CommandScope.PrivateChats],
  },
  {
    command: 'attach',
    description: 'Attach to an existing Claude session',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.PrivateChats],
  },
  {
    command: 'switch',
    description: 'Switch to a different session',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'close',
    description: 'Close and terminate current session',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'status',
    description: 'Show current session status',
    category: CommandCategory.SessionManagement,
    scopes: [CommandScope.PrivateChats, CommandScope.GroupChats, CommandScope.ChatWithSession],
  },

  // ============================================================================
  // Session Interaction Commands
  // ============================================================================
  {
    command: 'abort',
    description: 'Send Ctrl+C to abort current operation',
    category: CommandCategory.SessionInteraction,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'kill',
    description: 'Force kill the Claude process',
    category: CommandCategory.SessionInteraction,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'escape',
    description: 'Send ESC key to allow new prompt',
    category: CommandCategory.SessionInteraction,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'cd',
    description: 'Change working directory',
    category: CommandCategory.SessionInteraction,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'babysit',
    description: 'Start Babysitter workflow orchestration',
    category: CommandCategory.SessionInteraction,
    scopes: [CommandScope.ChatWithSession],
  },

  // ============================================================================
  // Utility Commands
  // ============================================================================
  {
    command: 'pwd',
    description: 'Show current working directory',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'file',
    description: 'Get file contents from session',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'diff',
    description: 'Show git diff in session directory',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'git',
    description: 'Quick git operations',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'tree',
    description: 'Show directory tree view',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'log',
    description: 'View session output history',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'report',
    description: 'Get latest run report',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'reporthistory',
    description: 'Get report from completed historical runs',
    category: CommandCategory.Utility,
    scopes: [CommandScope.PrivateChats, CommandScope.ChatWithSession],
  },
  {
    command: 'bookmark',
    description: 'Save or recall prompts',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'context',
    description: 'Show context token usage',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },
  {
    command: 'cost',
    description: 'Get session cost information',
    category: CommandCategory.Utility,
    scopes: [CommandScope.ChatWithSession],
  },

  // ============================================================================
  // Settings Commands
  // ============================================================================
  {
    command: 'voice',
    description: 'Toggle voice message transcription',
    category: CommandCategory.Settings,
    scopes: [CommandScope.PrivateChats],
  },
  {
    command: 'notify',
    description: 'Configure notification settings',
    category: CommandCategory.Settings,
    scopes: [CommandScope.PrivateChats],
  },
  {
    command: 'verbosity',
    description: 'Set output verbosity level',
    category: CommandCategory.Settings,
    scopes: [CommandScope.PrivateChats],
  },
  {
    command: 'upload',
    description: 'Toggle file upload handling',
    category: CommandCategory.Settings,
    scopes: [CommandScope.PrivateChats],
  },
  {
    command: 'streaming',
    description: 'Configure streaming output mode',
    category: CommandCategory.Settings,
    scopes: [CommandScope.PrivateChats],
  },

  // ============================================================================
  // Threaded Mode Commands (Groups with Forum Topics)
  // ============================================================================
  {
    command: 'threads',
    description: 'Configure threaded session mode',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
  {
    command: 'topic',
    description: 'Manage forum topics',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
  {
    command: 'threadsession',
    description: 'Show session bound to this thread',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
  {
    command: 'threadsessions',
    description: 'List all session-thread bindings',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
  {
    command: 'linksession',
    description: 'Link existing session to thread',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
  {
    command: 'unlinksession',
    description: 'Unlink session from thread',
    category: CommandCategory.ThreadedMode,
    scopes: [CommandScope.GroupChats],
  },
];

/**
 * Get commands filtered by scope
 * @param scope The scope to filter by
 * @returns Array of command definitions for the specified scope
 */
export function getCommandsByScope(scope: CommandScope): BotCommandDefinition[] {
  return COMMAND_DEFINITIONS.filter(cmd => cmd.scopes.includes(scope));
}

/**
 * Get commands filtered by category
 * @param category The category to filter by
 * @returns Array of command definitions for the specified category
 */
export function getCommandsByCategory(category: CommandCategory): BotCommandDefinition[] {
  return COMMAND_DEFINITIONS.filter(cmd => cmd.category === category);
}

/**
 * Get commands formatted for Telegram's setMyCommands API
 * @param scope The scope to get commands for
 * @returns Array of {command, description} objects for Telegram API
 */
export function getCommandsForTelegramAPI(scope: CommandScope): Array<{ command: string; description: string }> {
  return getCommandsByScope(scope).map(cmd => ({
    command: cmd.command,
    description: cmd.description,
  }));
}

/**
 * Get all unique command names
 * @returns Set of all command names
 */
export function getAllCommandNames(): Set<string> {
  return new Set(COMMAND_DEFINITIONS.map(cmd => cmd.command));
}
