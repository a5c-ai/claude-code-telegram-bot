# Claude Code Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Telegraf](https://img.shields.io/badge/Telegraf-4.16-blue.svg)](https://telegraf.js.org/)
[![100% Built with Babysitter](https://img.shields.io/badge/100%25%20Built%20with-Babysitter%20%F0%9F%A7%99-blueviolet)](https://a5c.ai)

A Telegram bot that bridges your mobile device with Anthropic's Claude Code CLI, enabling remote operation from anywhere. Create sessions, manage multiple projects, and interact with Claude's agentic coding capabilities directly through Telegram.

## Demo

https://github.com/user-attachments/assets/a8c14166-13f6-455b-b38a-aaa5ea499f80

---

## Features

### Persistent Process Architecture

The bot uses a **single long-lived Claude CLI process per session** with bidirectional stdin/stdout streaming JSON communication. This architecture provides:

- **Instant message handling** - No process spawn overhead per message
- **Session continuity** - Maintains conversation context across all interactions
- **Efficient resource usage** - Single process handles multiple message exchanges
- **Native question/answer flow** - Responses to Claude's questions stream through stdin

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Remote Access** | Control Claude Code CLI from your phone or any device with Telegram |
| **Session Management** | Create, list, switch, attach to, and close multiple Claude Code sessions |
| **Interactive Q&A** | Receive Claude's questions as Telegram messages with inline response buttons |
| **Streaming Responses** | Real-time draft message bubbles via Bot API 9.3 with configurable modes |
| **Forum Topic Threading** | Bind sessions to specific forum threads for organized multi-project workflows |
| **Multi-User Support** | Multiple authorized users can share the same bot instance |

### Input Methods

| Feature | Description |
|---------|-------------|
| **Text Messages** | Send prompts directly to Claude |
| **Voice Messages** | Transcription via OpenAI Whisper API |
| **File Uploads** | Documents, images, and code files sent to Claude |
| **Inline Buttons** | Quick responses to Claude's questions |

### Session Discovery

| Feature | Description |
|---------|-------------|
| **Session Scanning** | Discover Claude sessions from `~/.claude/history.jsonl` |
| **Session Attachment** | Attach to sessions started from terminal or other tools |
| **Partial ID Matching** | Use just the first 8 characters of a session ID |

---

## Important Security Notice

**This bot runs with `--dangerously-skip-permissions` enabled.**

With this flag, Claude will automatically read, write, delete files, run commands, and modify your system based on prompts without asking for confirmation.

**Recommended for:**
- Sandboxed development environments (Docker, VMs)
- Disposable/ephemeral environments
- Projects with version control where changes can be reverted

**NOT recommended for:**
- Production servers
- Systems with sensitive data (credentials, keys, personal info)
- Shared systems with other users' data
- Environments without backups

---

## Prerequisites

Before installing, ensure you have:

- **Node.js 18+** - [Download from nodejs.org](https://nodejs.org/)
- **Claude Code CLI** - Installed and authenticated with your Anthropic account ([Installation Guide](https://docs.anthropic.com/en/docs/claude-code))
- **Telegram Bot Token** - Create via [@BotFather](https://t.me/BotFather) (see instructions below)
- **Your Telegram User ID** - For authorization (see instructions below)

### Getting Your Bot Token

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` command
3. Follow the prompts to choose a name and username for your bot
4. Copy the bot token provided (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Finding Your User ID

1. Open Telegram and message [@userinfobot](https://t.me/userinfobot)
2. The bot will reply with your user ID (a numeric value like `123456789`)
3. Save this ID for the `ALLOWED_USER_IDS` configuration

---

## Installation

### Quick Install (npm)

```bash
npm install -g @a5c-ai/claude-code-telegram-bot
```

Create a `.env` file with your configuration and run:

```bash
claude-code-telegram-bot
```

### From Source

```bash
# Clone the repository
git clone https://github.com/a5c-ai/claude-code-telegram-bot.git
cd claude-code-telegram-bot

# Install dependencies
npm install

# Create environment configuration
cp .env.example .env

# Configure your .env file (see Environment Setup section below)

# Build and start
npm run build
npm start
```

---

## Configuration

### Environment Setup

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your configuration:**
   ```bash
   # Required: Your Telegram bot token from @BotFather
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz

   # Required: Comma-separated Telegram user IDs allowed to use the bot
   ALLOWED_USER_IDS=123456789,987654321

   # Optional: Default working directory for new sessions
   DEFAULT_WORKING_DIR=/home/user/projects
   ```

3. **Save the file and start the bot.**

### Required Settings

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) | `123456789:ABCdef...` |
| `ALLOWED_USER_IDS` | Comma-separated list of authorized Telegram user IDs | `123456789,987654321` |

### Optional Settings

| Variable | Description | Default |
|----------|-------------|--------|
| `CLAUDE_CLI_PATH` | Absolute path to claude CLI executable | Auto-detected |
| `DEFAULT_WORKING_DIR` | Default directory for new sessions | Current directory |
| `LOG_LEVEL` | Logging level (`error`, `warn`, `info`, `debug`) | `info` |
| `DEFAULT_VERBOSITY` | Output verbosity (`minimal`, `normal`, `verbose`) | `normal` |

### Voice Transcription

| Variable | Description | Default |
|----------|-------------|--------|
| `VOICE_ENABLED` | Enable voice message transcription | `false` |
| `OPENAI_API_KEY` | OpenAI API key for Whisper transcription | - |

### File Uploads

| Variable | Description | Default |
|----------|-------------|--------|
| `FILE_UPLOAD_ENABLED` | Enable file upload support | `false` |
| `MAX_FILE_SIZE_MB` | Maximum file size in megabytes | `10` |

### Notification Defaults

| Variable | Description | Default |
|----------|-------------|--------|
| `NOTIFICATION_DEFAULTS` | JSON object for default notification preferences | `{"completion":true,"error":true,"warning":true,"progress":false}` |

### Streaming Configuration

| Variable | Description | Default |
|----------|-------------|--------|
| `STREAMING_ENABLED` | Enable streaming draft messages | `true` |
| `STREAMING_MODE` | Mode: `partial`, `block`, or `off` | `partial` |
| `STREAMING_BLOCK_SIZE` | Characters per block in `block` mode | `50` |
| `STREAMING_UPDATE_INTERVAL_MS` | Minimum interval between updates | `200` |

### Run Reporting

| Variable | Description | Default |
|----------|-------------|--------|
| `RUN_REPORTS_ENABLED` | Enable HTML run reports | `true` |
| `RUN_REPORTS_AUTOSEND` | Auto-send a report after each run | `true` |
| `RUN_REPORTS_BABYSITTER_ONLY` | Auto-send only for Babysitter runs | `true` |
| `RUN_REPORTS_MAX_OUTPUT_CHARS` | Max output captured per run | `12000` |
| `RUN_REPORTS_MAX_EVENTS` | Max events captured per run | `200` |
| `RUN_REPORTS_MAX_TOOL_INPUT_CHARS` | Max tool input captured | `2000` |
| `RUN_REPORTS_MAX_RUNS` | Max runs kept per session | `25` |
| `RUN_REPORTS_MAX_FILE_MB` | Max report file size to send | `45` |
| `RUN_REPORTS_PREVIEW_DIR` | Optional local directory to save report HTML files | - |

### Threaded Mode (Forum Topics)

| Variable | Description | Default |
|----------|-------------|--------|
| `THREADED_MODE_ENABLED` | Enable forum topic session binding | `false` |
| `THREADED_AUTO_CREATE` | Auto-create topics for new sessions | `false` |
| `THREADED_DEFAULT_TOPIC` | Prefix for auto-created topic names | `""` |

---

## Commands

### General

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and quick help |
| `/help` | Show all available commands |

### Session Management

| Command | Description | Example |
|---------|-------------|--------|
| `/new <name> [dir]` | Create a new Claude Code session | `/new myproject /path/to/project` |
| `/sessions` | List existing Claude sessions on system | `/sessions` |
| `/attach <id> [dir]` | Attach to an existing Claude session | `/attach abc12345` |
| `/list` | List all active bot sessions | `/list` |
| `/switch <id>` | Switch to a different session | `/switch 01HGXK...` |
| `/close [id]` | Close and terminate a session | `/close 01HGXK...` |
| `/status` | Show current session details | `/status` |
| `/cd <path>` | Change working directory of current session | `/cd /home/user/project` |

### Session Control

| Command | Description |
|---------|-------------|
| `/abort` | Send Ctrl+C to abort current operation |
| `/escape` | Send ESC key to interrupt and allow new prompt |
| `/kill` | Force kill the Claude process (hard stop) |

### File Operations

| Command | Description | Example |
|---------|-------------|--------|
| `/file <path> [--raw]` | View file contents or directory listing | `/file src/index.ts` |
| `/pwd` | Show current working directory | `/pwd` |
| `/tree [depth] [path]` | Show directory tree | `/tree 3 src/` |

### Git Operations

| Command | Description | Example |
|---------|-------------|--------|
| `/diff [--staged] [path]` | Show git diff | `/diff --staged` |
| `/git [cmd] [args]` | Quick git operations | `/git status` |

### Utility Commands

| Command | Description | Example |
|---------|-------------|--------|
| `/log [n]` | View last n lines of output history | `/log 50` |
| `/bookmark [action]` | Save/recall/list prompts | `/bookmark save test "run tests"` |
| `/context` | Show context usage (tokens, percentage) | `/context` |
| `/cost` | Show session cost information | `/cost` |
| `/report [runId]` | Download latest run report | `/report` |
| `/reporthistory <projectPath> [--index N] [--session id] [--all]` | Download report from already completed runs | `/reporthistory /Users/me/project --index 2` |
| `/babysit` | Start Babysitter workflow orchestration | `/babysit` |

### Run Report Commands

Generate HTML dashboards for live and historical runs:

| Command | Purpose |
|---------|---------|
| `/report` | Send report for latest tracked run in current session |
| `/report <runIdPrefix>` | Send report for a specific tracked run ID prefix |
| `/reporthistory <projectPath>` | Send report for latest historical Babysitter run in project |
| `/reporthistory <projectPath> --index N` | Pick older historical run (`1` = latest) |
| `/reporthistory <projectPath> --session <sessionIdPrefix>` | Limit to one Claude session |
| `/reporthistory <projectPath> --all` | Include non-Babysitter runs |

Examples:

```bash
/report
/report 01KHBV
/reporthistory /Users/matrixy/Dev/MaTriXy/oneLine
/reporthistory "/Users/matrixy/Dev/MaTriXy/oneLine" --index 3
/reporthistory /Users/matrixy/Dev/MaTriXy/oneLine --session 51970530
/reporthistory /Users/matrixy/Dev/MaTriXy/oneLine --all
```

Notes:
- Historical runs are read from Claude logs under `~/.claude/projects/...`.
- By default, `/reporthistory` filters to Babysitter runs.
- Temporary report files are deleted after Telegram send. If `RUN_REPORTS_PREVIEW_DIR` is set, a persistent preview copy is also saved there.

### Settings

| Command | Description | Example |
|---------|-------------|--------|
| `/voice [on\|off]` | Toggle voice message transcription | `/voice on` |
| `/notify <type> [on\|off]` | Configure notifications | `/notify error off` |
| `/verbosity [level]` | Set output verbosity | `/verbosity verbose` |
| `/upload [on\|off]` | Toggle file upload support | `/upload on` |
| `/streaming [mode]` | Configure streaming output mode | `/streaming partial` |

### Threaded Mode (Forum Topics)

| Command | Description | Example |
|---------|-------------|--------|
| `/threads` | Configure threaded session mode | `/threads` |
| `/topic` | Manage forum topics | `/topic create MySession` |
| `/threadsession` | Show session bound to this thread | `/threadsession` |
| `/threadsessions` | List all session-thread bindings | `/threadsessions` |
| `/linksession <id>` | Link existing session to thread | `/linksession 01HGXK...` |
| `/unlinksession` | Unlink session from thread | `/unlinksession` |

---

## Usage

### Creating Your First Session

```
/new backend-api /home/user/projects/my-api
```

Creates a new session named "backend-api" in the specified directory. The session automatically becomes active.

### Sending Prompts

Once a session is active, simply type your request:

```
Create a REST endpoint for user authentication using JWT tokens
```

Claude will process your request and respond with its plan, code changes, and any questions.

### Responding to Questions

When Claude needs input, you'll receive a message with inline buttons:

```
Claude wants to create a new file:
auth/middleware.ts

[Yes, proceed] [No, skip] [Other...]
```

Tap a button to respond, or select "Other" to type a custom answer.

### Attaching to Existing Sessions

Discover and attach to Claude sessions started outside Telegram:

```
/sessions
```

Shows recent sessions from `~/.claude/history.jsonl`:

```
📁 my-project
   ID: `abc12345...`
   2h ago
   "Last message preview..."
```

Attach using partial ID:

```
/attach abc12345
```

### Using Voice Messages

If voice transcription is enabled:

1. Enable voice: `/voice on`
2. Send a voice message in Telegram
3. The bot transcribes it via OpenAI Whisper
4. Transcribed text is sent to Claude

### Uploading Files

If file uploads are enabled:

1. Enable uploads: `/upload on`
2. Send a document or photo in Telegram
3. Text files are embedded in the message; images/binaries are saved and path sent to Claude

### Streaming Modes

Configure how Claude's responses appear:

| Mode | Behavior |
|------|----------|
| `partial` | Real-time character-by-character streaming via draft bubbles |
| `block` | Updates in chunks of configurable size |
| `off` | Wait for complete response before showing |

### Forum Topic Threading

In Telegram groups with forum topics enabled:

1. Enable threaded mode: `/threads on`
2. Create a topic: `/topic create ProjectX`
3. Link a session: `/linksession <session-id>`
4. Messages in that topic go to the linked session

---

## Architecture Overview

The bot uses a layered architecture with these primary components:

| Component | Responsibility |
|-----------|----------------|
| **TelegramBot** | Main orchestrator - handles Telegram commands, user authorization, message routing |
| **SessionManager** | Session lifecycle management with ULID-based IDs |
| **ClaudeCodeProcess** | Persistent process wrapper with stdin/stdout streaming JSON |
| **OutputParser** | Parses stream-json output, detects questions, emits typed events |
| **StreamingService** | Bot API 9.3 draft message handling |
| **DraftMessageHandler** | Draft bubble state management and throttling |
| **ThreadManager** | Forum topic to session binding |
| **TopicHandler** | Forum topic CRUD operations |
| **ClaudeSessionScanner** | Scans `~/.claude/history.jsonl` for existing sessions |
| **VoiceHandler** | Voice message transcription via OpenAI Whisper |
| **FileHandler** | File upload validation and processing |
| **NotificationManager** | Per-user notification preferences |
| **CommandDefinitions** | Command metadata for Telegram menu registration |
| **CommandRegistrationService** | Registers commands with Telegram Bot API |

### Process Flow

```
User Message → TelegramBot → SessionManager → ClaudeCodeProcess (stdin)
                                                      ↓
                                              Claude CLI (persistent)
                                                      ↓
                                              stdout (stream-json)
                                                      ↓
                                              OutputParser (events)
                                                      ↓
                              ┌─────────────────────────────────────┐
                              ↓                    ↓                ↓
                          'text'              'question'        'progress'
                              ↓                    ↓                ↓
                       StreamingService    Inline Keyboard    Status Updates
                              ↓                    ↓                ↓
                       Draft Bubble ──────→ Telegram Message ←─────┘
```

### Event Types

OutputParser emits:
- `started` - Claude session initialized
- `thinking` - Claude started processing
- `text` - Assistant text response
- `question` - Interactive question (AskUserQuestion tool)
- `tool_call` - Tool invocation
- `progress` - Tool execution progress
- `streaming_delta` - Partial text chunks (when streaming enabled)
- `streaming_complete` - Stream finished

---

## Development

### Running in Development Mode

```bash
npm run dev
```

### Running Tests

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```

### Project Structure

```
claude-code-telegram/
├── src/
│   ├── index.ts                       # Entry point
│   ├── bot/
│   │   ├── TelegramBot.ts             # Main bot implementation
│   │   └── commands/
│   │       ├── CommandDefinitions.ts  # Command metadata
│   │       └── CommandRegistrationService.ts
│   ├── session/
│   │   ├── SessionManager.ts          # Session lifecycle
│   │   └── ClaudeCodeProcess.ts       # Persistent process wrapper
│   ├── parser/
│   │   └── OutputParser.ts            # Stream JSON parser
│   ├── streaming/
│   │   ├── StreamingService.ts        # Bot API 9.3 drafts
│   │   └── DraftMessageHandler.ts     # Draft state management
│   ├── threaded/
│   │   ├── ThreadManager.ts           # Session-thread binding
│   │   └── TopicHandler.ts            # Forum topic CRUD
│   ├── utils/
│   │   ├── ClaudeSessionScanner.ts    # Session discovery
│   │   ├── VoiceHandler.ts            # Voice transcription
│   │   └── FileHandler.ts             # File uploads
│   ├── notifications/
│   │   └── NotificationManager.ts     # Notification preferences
│   ├── types/
│   │   └── index.ts                   # TypeScript interfaces
│   └── config/
│       └── index.ts                   # Configuration management
├── tests/
├── package.json
├── tsconfig.json
└── .env.example
```

---

## Troubleshooting

### Bot not responding

1. Verify your Telegram user ID is in `ALLOWED_USER_IDS`
2. Ensure `TELEGRAM_BOT_TOKEN` is correct
3. Run with `LOG_LEVEL=debug` for verbose output
4. Check for "Telegram bot started successfully" in logs

### "No active session" error

Create a session first:
```
/new my-session /path/to/project
```

### Claude CLI not found

1. Verify installation: `claude --version`
2. Check PATH or set `CLAUDE_CLI_PATH=/full/path/to/claude` in `.env`

Common paths:
- macOS (Apple Silicon): `/opt/homebrew/bin/claude`
- macOS (Intel) / Linux: `/usr/local/bin/claude`
- Linux system-wide: `/usr/bin/claude`

### Claude not responding to prompts

1. Check session status: `/status`
2. Verify working directory exists and is accessible
3. Test Claude CLI manually: `claude --version`
4. Abort stuck process: `/abort` or `/kill`

### /sessions shows no sessions

1. Check Claude history file exists: `ls ~/.claude/history.jsonl`
2. Verify Claude has been used at least once
3. Check file permissions on `~/.claude/`

### /attach fails to find session

1. Use partial ID (first 8 characters)
2. Run `/sessions` to verify session exists
3. Specify working directory if original moved: `/attach abc12345 /new/path`

### Streaming not working

1. Verify `STREAMING_ENABLED=true`
2. Check `STREAMING_MODE` is not `off`
3. Bot API 9.3 draft messages require recent Telegram client

### Messages getting truncated

Telegram limits messages to 4096 characters. Long responses are automatically truncated with "...(truncated)" indicator.

---

## Limitations

| Limitation | Details |
|------------|--------|
| **Message size** | Telegram 4096 character limit per message |
| **File uploads** | 10MB default (configurable) |
| **Input length** | 10KB maximum to prevent abuse |
| **Session persistence** | Bot sessions lost on restart (Claude history preserved in `~/.claude/`) |
| **Windows support** | Not tested; may require path adjustments |

---

## Security

### Authorization

- Whitelist-based access via `ALLOWED_USER_IDS`
- Per-message verification against whitelist
- Unauthorized access attempts are logged

### Process Isolation

- Child processes spawned with sanitized environment
- `CLAUDE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` stripped

### Input Validation

- Maximum 10,240 characters per message
- Rate limiting: minimum 1 second between messages
- Maximum 50 queued messages
- File size limits and extension whitelist
- Path traversal protection

### Best Practices

1. Restrict `ALLOWED_USER_IDS` to trusted users only
2. Create a dedicated bot specifically for this purpose
3. Run in sandboxed environment (Docker, VM)
4. Keep dependencies updated
5. Monitor sessions regularly with `/list`

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Ensure all tests pass: `npm test`
5. Submit a pull request with clear description

---

## Contributors

<a href="https://github.com/a5c-ai/claude-code-telegram-bot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=a5c-ai/claude-code-telegram-bot" />
</a>

---

## Star History

<a href="https://star-history.com/#a5c-ai/claude-code-telegram-bot&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=a5c-ai/claude-code-telegram-bot&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=a5c-ai/claude-code-telegram-bot&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=a5c-ai/claude-code-telegram-bot&type=Date" />
 </picture>
</a>

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Note:** This project is not officially affiliated with Anthropic. Claude Code is a product of Anthropic.

---

[![100% Built with Babysitter](https://img.shields.io/badge/100%25%20Built%20with-Babysitter%20%F0%9F%A7%99-blueviolet)](https://a5c.ai) **100% Built using [Babysitter](https://github.com/a5c-ai/babysitter) by [a5c.ai](https://a5c.ai)** - AI-powered development orchestration.
