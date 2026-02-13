#!/usr/bin/env node
/**
 * Claude Code Telegram Bot
 *
 * A Telegram bot that allows remote operation of Claude Code CLI.
 *
 * 🧙 100% Built using Babysitter by a5c.ai
 */

import { getExtendedTelegramBotConfig, getLogLevel } from './config/index.js';
import { TelegramBot } from './bot/TelegramBot.js';

async function main(): Promise<void> {
  const logLevel = getLogLevel();
  console.log(`[${new Date().toISOString()}] Starting Claude Code Telegram Bot (log level: ${logLevel})`);

  try {
    const config = getExtendedTelegramBotConfig();
    console.log(`[${new Date().toISOString()}] Loaded configuration`);
    console.log(`[${new Date().toISOString()}] Allowed users: ${config.allowedUserIds.join(', ')}`);

    const bot = new TelegramBot(config);
    await bot.start();

  } catch (error) {
    console.error('[ERROR] Failed to start bot:', error);
    process.exit(1);
  }
}

main();
