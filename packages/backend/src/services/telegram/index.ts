// TelegramService — Gateway that routes Telegram messages through AgentService
// Owner-only. Routes to active thread (same conversation, different window).
// Supports: text, photos, voice messages, audio files, documents.
// Outbound: text + voice notes (ElevenLabs TTS with tone tags).

import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import crypto from 'crypto';
import { getTelegramConfig } from './config.js';
import { TelegramDebouncer } from './debouncer.js';
import type { TelegramBatch, TelegramQueuedMessage } from './debouncer.js';
import { splitResponse, getTelegramThreadId } from './utils.js';
import type { AgentService } from '../agent.js';
import type { VoiceService } from '../voice.js';
import { createMessage, createThread, getThread, getMostRecentActiveThread, updateThreadActivity, setConfig } from '../db.js';
import { getBotToken } from '../bot-token.js';
import { saveFile } from '../files.js';
import { getSanctumConfig } from '../../config.js';
import { bindCurrentTenant, envFor } from '../../tenancy/context.js';
import { UPDATING_REPLY, noticeOnce, updateBlocking } from '../update-block.js';
import type { registry as registryInstance } from '../ws.js';
import { requireCapability } from '../consent/gate.js';

type ConnectionRegistry = typeof registryInstance;

export class TelegramService {
  private bot: Telegraf;
  private agentService: AgentService;
  private voiceService: VoiceService;
  private registry: ConnectionRegistry;
  private debouncer: TelegramDebouncer;
  private started = false;
  /** Bumped by stop(): a start() still awaiting getMe() sees it changed and abandons (no polling, no health interval). */
  private generation = 0;
  /** The start() in flight (settles once it has launched or abandoned), so stop() can wait for its abandonment. */
  private pendingStart: Promise<void> | null = null;
  private lastPollingActivity: number = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;

  // Track recent Telegram message IDs for reactions
  private recentMessageIds: { messageId: number; role: 'user' | 'companion'; timestamp: number }[] = [];

  // Stats
  private stats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  constructor(agentService: AgentService, registry: ConnectionRegistry, voiceService: VoiceService) {
    this.agentService = agentService;
    this.registry = registry;
    this.voiceService = voiceService;

    const token = getBotToken('telegram');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in DB or env');

    this.bot = new Telegraf(token);
    this.debouncer = new TelegramDebouncer();
    this.debouncer.onBatch(bindCurrentTenant(this.handleBatch.bind(this))); // (a timer's callback runs as the tenant this service was built for)
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const config = getSanctumConfig();

    // Track polling activity + debug logging
    this.bot.use(bindCurrentTenant(async (ctx, next) => {
      this.lastPollingActivity = Date.now();
      this.restartAttempts = 0; // Reset on successful message receipt
      if (ctx.message) {
        const msg = ctx.message as any;
        const types = ['text', 'voice', 'audio', 'video_note', 'video', 'document', 'photo', 'sticker']
          .filter(t => t in msg);
        console.log(`[Telegram] Incoming message types: [${types.join(', ')}]${msg.voice ? ` voice_duration=${msg.voice.duration}s mime=${msg.voice.mime_type}` : ''}`);
      }
      return next();
    }));

    // /start command — identify and store owner's chat ID.
    // MUST be registered BEFORE bot.on('text'): Telegraf runs handlers in
    // registration order, and bot.on('text') consumes /start (it never calls
    // next()), replying "send /start first" — so if the command handler is
    // registered after it, /start is swallowed and the owner can NEVER register
    // (the bot tells you to /start in response to /start itself — catch-22).
    this.bot.command('start', bindCurrentTenant(async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const telegramConfig = getTelegramConfig();

      if (!telegramConfig.ownerChatId) {
        setConfig('telegram.ownerChatId', chatId);
        await ctx.reply(`Connected. This chat is now linked to ${config.identity.companion_name}.`);
        console.log(`[Telegram] Owner chat ID stored: ${chatId}`);
      } else if (telegramConfig.ownerChatId === chatId) {
        await ctx.reply('Already connected.');
      } else {
        await ctx.reply('This bot is private.');
        console.log(`[Telegram] Rejected /start from unknown chat: ${chatId}`);
      }
    }));

    // Handle all text messages
    this.bot.on('text', bindCurrentTenant(async (ctx) => {
      await this.handleMessage(ctx);
    }));

    // Handle photos — download, save, and pass path to agent so it can see the image
    this.bot.on('photo', bindCurrentTenant(async (ctx) => {
      await this.handlePhotoMessage(ctx);
    }));

    // Handle voice messages (Telegram voice notes = .ogg opus)
    this.bot.on('voice', bindCurrentTenant(async (ctx) => {
      await this.handleVoiceMessage(ctx);
    }));

    // Handle audio files (music, recordings sent as files)
    this.bot.on('audio', bindCurrentTenant(async (ctx) => {
      const caption = ctx.message.caption || `[Audio: ${ctx.message.audio.file_name || 'audio'}]`;
      await this.handleMessage(ctx, caption);
    }));

    // Handle documents/files
    this.bot.on('document', bindCurrentTenant(async (ctx) => {
      const caption = ctx.message.caption || `[File: ${ctx.message.document.file_name || 'document'}]`;
      await this.handleMessage(ctx, caption);
    }));

    this.bot.catch(bindCurrentTenant((err: unknown) => {
      console.error('[Telegram] Bot error:', err);
      this.stats.errors++;
    }));
  }

  /**
   * Handle voice messages: download -> transcribe via Groq Whisper -> queue transcript.
   * Saves the audio file and includes transcript context for the agent.
   */
  private async handleVoiceMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) return;

    if (!this.voiceService.canTranscribe) {
      console.warn('[Telegram] Voice received but transcription not configured (GROQ_API_KEY missing)');
      await ctx.reply('Voice transcription not available — send text instead.');
      return;
    }

    this.stats.messagesReceived++;

    try {
      // Download voice file from Telegram
      const voice = (ctx.message as any).voice;
      if (!voice?.file_id) {
        console.error('[Telegram] Voice message has no file_id');
        return;
      }

      const fileLink = await ctx.telegram.getFileLink(voice.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        console.error(`[Telegram] Failed to download voice: ${response.status}`);
        return;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const mimeType = voice.mime_type || 'audio/ogg';
      const duration = voice.duration || 0;

      console.log(`[Telegram] Voice message: ${duration}s, ${audioBuffer.length} bytes, ${mimeType}`);

      // Save audio file
      const fileMeta = saveFile(audioBuffer, `voice-${Date.now()}.ogg`, mimeType);

      // Transcribe via Groq Whisper
      const transcript = await this.voiceService.transcribe(audioBuffer, mimeType);
      console.log(`[Telegram] Transcribed: "${transcript.slice(0, 100)}..."`);

      if (!transcript.trim()) {
        await ctx.reply('(Could not transcribe voice message)');
        return;
      }

      const config = getSanctumConfig();
      const voiceContext = `[Voice message from ${config.identity.user_name}, ${duration}s] "${transcript}"`;
      this.debouncer.add({
        content: voiceContext,
        ctx,
        metadata: {
          telegramChatId: chatId,
          telegramMessageId: ctx.message!.message_id,
          voiceFileId: fileMeta.fileId,
          voiceDuration: duration,
          voiceTranscript: transcript,
        },
        type: 'voice',
      }, chatId);

    } catch (error) {
      console.error('[Telegram] Voice handler error:', error);
      this.stats.errors++;
    }
  }

  /**
   * Handle photo messages: download highest-res version, save to disk, queue for agent.
   * Agent can then use Read tool to actually see the image.
   */
  private async handlePhotoMessage(ctx: Context<Update.MessageUpdate>): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) return;

    this.stats.messagesReceived++;

    try {
      // Get highest resolution photo (last in array)
      const photos = (ctx.message as any).photo;
      if (!photos?.length) {
        console.error('[Telegram] Photo message has no photos');
        return;
      }
      const bestPhoto = photos[photos.length - 1];

      const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
      const response = await fetch(fileLink.href);
      if (!response.ok) {
        console.error(`[Telegram] Failed to download photo: ${response.status}`);
        return;
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const mimeType = 'image/jpeg'; // Telegram always sends photos as JPEG
      console.log(`[Telegram] Photo: ${imageBuffer.length} bytes, ${bestPhoto.width}x${bestPhoto.height}`);

      // Save to disk so the agent can read it with its Read tool
      const fileMeta = saveFile(imageBuffer, `telegram-photo-${Date.now()}.jpg`, mimeType);

      const config = getSanctumConfig();
      const caption = (ctx.message as any).caption || '';
      const content = caption
        ? `[Photo from ${config.identity.user_name}] ${caption}\nImage saved at: data/files/${fileMeta.fileId}.jpg — use Read tool to see it.`
        : `[Photo from ${config.identity.user_name}]\nImage saved at: data/files/${fileMeta.fileId}.jpg — use Read tool to see it.`;

      this.debouncer.add({
        content,
        ctx,
        metadata: {
          telegramChatId: chatId,
          telegramMessageId: ctx.message!.message_id,
          photoFileId: fileMeta.fileId,
          photoWidth: bestPhoto.width,
          photoHeight: bestPhoto.height,
        },
        type: 'photo',
      }, chatId);

    } catch (error) {
      console.error('[Telegram] Photo handler error:', error);
      this.stats.errors++;
    }
  }

  private async handleMessage(ctx: Context<Update.MessageUpdate>, overrideContent?: string): Promise<void> {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    const telegramConfig = getTelegramConfig();

    // Auth: only owner's chat
    if (!telegramConfig.ownerChatId) {
      await ctx.reply('Send /start first to connect this chat.');
      return;
    }
    if (chatId !== telegramConfig.ownerChatId) {
      console.log(`[Telegram] Rejected message from unknown chat: ${chatId}`);
      return;
    }

    // An in-app update is installing: no turn can start. Say so once (one line), then ignore until the pause ends.
    if (updateBlocking()) {
      if (noticeOnce(`telegram:${chatId}`)) await ctx.reply(UPDATING_REPLY).catch(() => {});
      console.log('[Telegram] A message arrived while an update is installing; it was not processed.');
      return;
    }

    this.stats.messagesReceived++;

    const content = overrideContent || ('text' in ctx.message! ? ctx.message.text : '');
    if (!content) return;

    // Determine type for debouncer (audio/document handlers pass overrideContent)
    const msgType: TelegramQueuedMessage['type'] = overrideContent
      ? ((ctx.message as any).audio ? 'audio' : 'document')
      : 'text';

    this.debouncer.add({
      content,
      ctx,
      metadata: {
        telegramChatId: chatId,
        telegramMessageId: ctx.message!.message_id,
      },
      type: msgType,
    }, chatId);
  }

  /**
   * Handle a debounced batch of messages.
   * Text messages are combined into one prompt. Voice/photo/document flush immediately
   * and are processed individually.
   */
  private async handleBatch(batch: TelegramBatch): Promise<void> {
    const { messages, chatId } = batch;
    if (messages.length === 0) return;

    // Separate text messages from media messages
    const textMessages = messages.filter(m => m.type === 'text');
    const mediaMessages = messages.filter(m => m.type !== 'text');

    // Process combined text messages as one prompt
    if (textMessages.length > 0) {
      const combinedContent = textMessages.map(m => m.content).join('\n');
      const lastCtx = textMessages[textMessages.length - 1].ctx;
      const lastMetadata = textMessages[textMessages.length - 1].metadata;

      console.log(`[Telegram] Batch: ${textMessages.length} text message(s) combined`);
      await lastCtx.sendChatAction('typing').catch(() => {});
      await this.routeToAgent(lastCtx, chatId, combinedContent, lastMetadata);
    }

    // Process media messages individually (they already flushed immediately)
    for (const msg of mediaMessages) {
      await msg.ctx.sendChatAction('typing').catch(() => {});
      await this.routeToAgent(msg.ctx, chatId, msg.content, msg.metadata);
    }
  }

  /**
   * Shared routing: stores message, sends to agent, delivers response.
   * Response may be text or voice depending on whether the owner sent voice.
   */
  private async routeToAgent(
    ctx: Context<Update.MessageUpdate>,
    chatId: string,
    content: string,
    metadata: Record<string, any>,
  ): Promise<void> {
    const config = getSanctumConfig();
    console.log(`[Telegram] Message from ${config.identity.user_name}: ${content.slice(0, 80)}...`);

    // Track incoming message ID for reactions
    if (ctx.message?.message_id) {
      this.trackMessageId(ctx.message.message_id, 'user');
    }

    // Touch owner's activity
    this.registry.touchUserActivity();

    // Route to active thread (same as Discord does for owner)
    let threadId: string;
    let threadName: string;

    const activeThread = getMostRecentActiveThread();
    if (activeThread) {
      threadId = activeThread.id;
      threadName = activeThread.name;
      console.log(`[Telegram] Routed to active web thread: ${threadName} (${threadId})`);
    } else {
      // No active web thread — use Telegram-specific thread
      threadId = getTelegramThreadId(chatId);
      threadName = 'Telegram';
      console.log(`[Telegram] No active web thread — using Telegram thread`);
    }

    // Ensure thread exists
    let thread = getThread(threadId);
    if (!thread) {
      thread = createThread({
        id: threadId,
        name: threadName,
        type: 'named',
        createdAt: new Date().toISOString(),
        sessionType: 'v1',
      });
    }

    // Store incoming message
    const now = new Date().toISOString();
    const incomingMsg = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'user',
      content,
      contentType: metadata.voiceTranscript ? 'audio' : 'text',
      platform: 'telegram',
      metadata,
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    this.registry.broadcast({ type: 'message', message: incomingMsg });

    // Platform context — tell the agent this is Telegram
    const platformContext = [
      '=== PLATFORM: TELEGRAM ===',
      `This is ${config.identity.user_name} messaging via Telegram (mobile).`,
      'Keep responses concise — this is a small screen.',
      'Telegram supports markdown: *bold*, _italic_, `code`.',
      'Max message length: 4096 chars.',
      metadata.voiceTranscript
        ? `${config.identity.user_name} sent a voice message. Your reply will be auto-converted to a voice note via TTS.`
        : '',
    ].filter(Boolean).join('\n');

    this.stats.messagesProcessed++;

    // Process through AgentService
    const response = await this.agentService.processMessage(
      threadId,
      content,
      { name: threadName, type: 'named' },
      { platform: 'telegram', platformContext },
    );

    if (!response || response.trim() === '' || response === '[No response]') {
      console.log('[Telegram] Empty response from agent');
      return;
    }

    // If owner sent voice AND TTS is available, reply with voice + text fallback
    if (metadata.voiceTranscript && this.voiceService.canTTS) {
      try {
        const audioBuffer = await this.voiceService.generateTTS(response);
        await ctx.replyWithVoice({ source: audioBuffer, filename: 'voice.mp3' });
        console.log(`[Telegram] Sent voice reply (${audioBuffer.length} bytes)`);
        return;
      } catch (error) {
        console.error('[Telegram] Voice reply failed, falling back to text:', error);
      }
    }

    // Text reply (default or fallback)
    const chunks = splitResponse(response);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 200));
      await ctx.reply(chunks[i]);
    }

    console.log(`[Telegram] Sent ${chunks.length} text chunk(s)`);
  }

  /**
   * Send a text message to the owner proactively (for outbound/autonomous messages).
   */
  async sendToOwner(text: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram text', summary: text ? `${text}` : 'text' });

    const chunks = splitResponse(text);
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 200));
      await this.bot.telegram.sendMessage(telegramConfig.ownerChatId, chunks[i]);
    }
  }

  /**
   * Send a voice note to the owner via TTS.
   * Text can include ElevenLabs v3 tone tags:
   * [whispers] [softly] [excited] [laughs] [sighs] [playfully] [calm]
   * [gasps] [dramatically] [deadpan] [cheerfully] [nervous] [mischievously]
   */
  async sendVoiceToOwner(text: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send voice — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram voice note', summary: text ? `${text}` : 'voice note' });
    if (this.voiceService.canTTS) requireCapability('voice_out', { harness: 'server', tool: 'telegram voice note', summary: text });

    if (!this.voiceService.canTTS) {
      console.warn('[Telegram] TTS not configured — falling back to text');
      await this.sendToOwner(text);
      return;
    }

    try {
      const audioBuffer = await this.voiceService.generateTTS(text);
      await this.bot.telegram.sendVoice(telegramConfig.ownerChatId, {
        source: audioBuffer,
        filename: 'voice.mp3',
      });
      console.log(`[Telegram] Sent voice note (${audioBuffer.length} bytes)`);
    } catch (error) {
      console.error('[Telegram] Voice send error:', error);
      await this.sendToOwner(text);
    }
  }

  /**
   * Send a photo to the owner. Source can be a URL string or a Buffer.
   */
  async sendPhotoToOwner(source: string | Buffer, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send photo — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram photo', summary: caption ? `${caption}` : 'photo' });

    try {
      const photoSource = typeof source === 'string'
        ? { url: source }
        : { source, filename: 'image.png' };
      await this.bot.telegram.sendPhoto(telegramConfig.ownerChatId, photoSource, { caption });
      console.log(`[Telegram] Sent photo${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ''}`);
    } catch (error) {
      console.error('[Telegram] Photo send error:', error);
    }
  }

  /**
   * Send a document/file to the owner. Source can be a URL string or a Buffer.
   */
  async sendDocumentToOwner(source: string | Buffer, filename: string, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send document — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram document', summary: caption ?? filename ? `${caption ?? filename}` : 'document' });

    try {
      const docSource = typeof source === 'string'
        ? { url: source, filename }
        : { source, filename };
      await this.bot.telegram.sendDocument(telegramConfig.ownerChatId, docSource, { caption });
      console.log(`[Telegram] Sent document: ${filename}`);
    } catch (error) {
      console.error('[Telegram] Document send error:', error);
    }
  }

  /**
   * Send an animation/GIF to the owner. Source can be a URL string or a Buffer.
   */
  async sendAnimationToOwner(source: string | Buffer, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send animation — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram animation', summary: caption ? `${caption}` : 'animation' });

    try {
      const animSource = typeof source === 'string'
        ? { url: source }
        : { source, filename: 'animation.gif' };
      await this.bot.telegram.sendAnimation(telegramConfig.ownerChatId, animSource, { caption });
      console.log(`[Telegram] Sent animation${caption ? ` (caption: ${caption.slice(0, 40)}...)` : ''}`);
    } catch (error) {
      console.error('[Telegram] Animation send error:', error);
    }
  }

  /**
   * Search for a GIF and send it to the owner.
   * Uses GIPHY API (requires GIPHY_API_KEY env var).
   */
  async sendGifToOwner(query: string, caption?: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot send GIF — owner chat ID not set');
      return;
    }
    requireCapability('outward_telegram', { harness: 'server', tool: 'telegram GIF', summary: query ? `${query}` : 'GIF' });

    try {
      const apiKey = envFor('the GIF search').GIPHY_API_KEY;
      if (!apiKey) {
        console.error('[Telegram] GIPHY_API_KEY not set — cannot search GIFs');
        return;
      }
      const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=5&rating=r`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[Telegram] GIPHY search failed: ${res.status}`);
        return;
      }

      const data = await res.json() as any;
      const results = data?.data;
      if (!results?.length) {
        console.log(`[Telegram] No GIF results for: ${query}`);
        return;
      }

      // Pick a random result from top 5 for variety
      const pick = results[Math.floor(Math.random() * results.length)];
      const gifUrl = pick.images?.downsized?.url || pick.images?.original?.url;
      if (!gifUrl) {
        console.error('[Telegram] GIF result has no URL');
        return;
      }

      await this.bot.telegram.sendAnimation(telegramConfig.ownerChatId, { url: gifUrl }, { caption });
      console.log(`[Telegram] Sent GIF for "${query}": ${gifUrl.slice(0, 60)}...`);
    } catch (error) {
      console.error('[Telegram] GIF send error:', error);
    }
  }

  /**
   * React to a message with an emoji.
   * target: 'last', 'last-2', 'last-3', or a numeric message ID.
   */
  async reactToMessage(target: string, emoji: string): Promise<void> {
    const telegramConfig = getTelegramConfig();
    if (!telegramConfig.ownerChatId) {
      console.warn('[Telegram] Cannot react — owner chat ID not set');
      return;
    }

    let messageId: number;

    if (target.startsWith('last')) {
      // Resolve from recent message tracker
      const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
      // Filter to owner's messages for reactions
      const ownerMessages = this.recentMessageIds.filter(m => m.role === 'user');
      if (offset >= ownerMessages.length) {
        console.warn(`[Telegram] No message at offset ${offset} (have ${ownerMessages.length} tracked)`);
        return;
      }
      messageId = ownerMessages[offset].messageId;
    } else {
      messageId = parseInt(target, 10);
      if (isNaN(messageId)) {
        console.error(`[Telegram] Invalid reaction target: ${target}`);
        return;
      }
    }

    try {
      await this.bot.telegram.setMessageReaction(
        parseInt(telegramConfig.ownerChatId, 10),
        messageId,
        [{ type: 'emoji', emoji } as any],
      );
      console.log(`[Telegram] Reacted ${emoji} to message ${messageId}`);
    } catch (error) {
      console.error('[Telegram] React error:', error);
    }
  }

  /** Track a Telegram message ID for reaction targeting. Keeps last 20. */
  private trackMessageId(messageId: number, role: 'user' | 'companion'): void {
    this.recentMessageIds.unshift({ messageId, role, timestamp: Date.now() });
    if (this.recentMessageIds.length > 20) this.recentMessageIds.length = 20;
  }

  async start(): Promise<void> {
    const run = this.startInner();
    this.pendingStart = run;
    try { await run; } finally { if (this.pendingStart === run) this.pendingStart = null; }
  }

  private async startInner(): Promise<void> {
    const token = getBotToken('telegram');
    if (!token) {
      console.error('[Telegram] no token in DB or env — gateway disabled');
      return;
    }

    const gen = this.generation;
    try {
      // Verify bot token is valid
      const me = await this.bot.telegram.getMe();
      if (gen !== this.generation) { console.log('[Telegram] start abandoned: stopped while verifying the bot'); return; } // stop() came during getMe: no polling, no interval
      console.log(`[Telegram] Bot verified: @${me.username}`);

      // launch() starts long-polling and never resolves — don't await it
      this.lastPollingActivity = Date.now();
      this.bot.launch({ allowedUpdates: ['message', 'callback_query'] }).catch(err => {
        console.error('[Telegram] Polling error:', err);
        this.stats.errors++;
      });

      this.started = true;

      // Health check every 5 minutes
      this.healthCheckInterval = setInterval(bindCurrentTenant(() => {
        this.healthCheck().catch(err =>
          console.error('[Telegram] Health check error:', err)
        );
      }), 5 * 60 * 1000);

      console.log('[Telegram] Gateway started (polling)');
    } catch (error) {
      console.error('[Telegram] Failed to start:', error);
    }
  }

  private async healthCheck(): Promise<void> {
    try {
      await this.bot.telegram.getMe();
      console.log('[Telegram] Health check OK');
    } catch (error) {
      console.error('[Telegram] Health check failed — polling may be dead:', error);
      await this.restart();
    }
  }

  private async restart(): Promise<void> {
    this.restartAttempts++;
    const backoffMs = Math.min(2000 * Math.pow(2, this.restartAttempts - 1), 60000);
    console.log(`[Telegram] Restart attempt ${this.restartAttempts} (backoff ${backoffMs}ms)`);

    this.stats.errors++;

    try {
      this.bot.stop('restart');
    } catch {
      // May already be stopped
    }

    await new Promise(r => setTimeout(r, backoffMs));
    if (!this.started) return; // stop() came during the backoff: no new polling after stop

    this.lastPollingActivity = Date.now();
    this.bot.launch({ allowedUpdates: ['message', 'callback_query'] }).catch(err => {
      console.error('[Telegram] Restart polling error:', err);
      this.stats.errors++;
    });

    console.log('[Telegram] Restarted polling');
  }

  async stop(): Promise<void> {
    this.generation++; // whatever start() still has in flight (getMe) is over
    const pending = this.pendingStart;
    if (pending) { // (bounded: a getMe that never answers must not hold a park; start abandons on its own when it does)
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pending, new Promise<void>((r) => { timer = setTimeout(r, 5000); timer.unref?.(); })]); } catch { /* start logs its own failure */ } finally { if (timer) clearTimeout(timer); }
    }
    if (!this.started) return;
    console.log('[Telegram] Shutting down gateway...');
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.debouncer.destroy();
    this.bot.stop('SIGTERM');
    this.started = false;
  }

  isConnected(): boolean {
    return this.started;
  }

  getStats() {
    return {
      ...this.stats,
      connected: this.isConnected(),
      restarts: this.restartAttempts,
    };
  }

  /** Resolve the bot's @username via getMe — thin exposure for the Settings
   *  channel test (bot is private; the route can't reach bot.telegram directly). */
  async getBotUsername(): Promise<string> {
    const me = await this.bot.telegram.getMe();
    return me.username;
  }
}
