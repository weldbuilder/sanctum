// Discord gateway types

import type { Message } from 'discord.js';

export interface QueuedMessage {
  message: Message;
  timestamp: number;
  lane: 'owner' | 'public';
}

export interface MessageBatch {
  /** Decided at intake, by channel (lanes.ts). */
  lane: 'owner' | 'public';
  messages: Message[];
  channelId: string;
  userId: string;
  guildId: string | null;
  combinedContent: string;
  firstMessage: Message;
  lastMessage: Message;
  channelHistory?: string;
}
