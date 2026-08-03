const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  /** Telegram sends one entry per resolution; largest is last. */
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  allow_sending_without_reply?: boolean;
}

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
  max_connections?: number;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly telegramError: string,
    public readonly status: number,
    public readonly errorCode?: number,
  ) {
    super(`Telegram ${method} failed: ${telegramError} (HTTP ${status})`);
  }
}

export class TelegramClient {
  private readonly apiUrl: string;

  constructor(
    private readonly botToken: string,
    private readonly baseUrl: string = TELEGRAM_API_BASE,
  ) {
    this.apiUrl = `${baseUrl}/bot${botToken}`;
  }

  private async request<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.apiUrl}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    const parsed = (await res.json()) as { ok: boolean; [k: string]: unknown };

    if (parsed.ok !== true) {
      const err = typeof parsed.description === "string" ? parsed.description : "unknown_error";
      throw new TelegramApiError(
        method,
        err,
        res.status,
        typeof parsed.error_code === "number" ? parsed.error_code : undefined,
      );
    }

    return parsed.result as T;
  }

  /** Identity of the bot behind this token. Doubles as the token-validity
   *  probe used when a tenant pastes their own bot token. */
  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe");
  }

  /** Long-poll pending updates. Telegram refuses this (409) while a webhook
   *  is registered for the same bot — callers must surface that rather than
   *  treating it as "no updates". */
  async getUpdates(params?: {
    offset?: number;
    limit?: number;
    timeout?: number;
    allowed_updates?: string[];
  }): Promise<TelegramUpdate[]> {
    return this.request<TelegramUpdate[]>("getUpdates", params ?? {});
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    return this.request<TelegramMessage>("sendMessage", params as unknown as Record<string, unknown>);
  }

  async sendChatAction(chatId: number | string, action: string): Promise<boolean> {
    return this.request<boolean>("sendChatAction", { chat_id: chatId, action });
  }

  async setWebhook(params: SetWebhookParams): Promise<boolean> {
    return this.request<boolean>("setWebhook", params as unknown as Record<string, unknown>);
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string }> {
    return this.request<{ file_id: string; file_path?: string }>("getFile", { file_id: fileId });
  }

  async getFileUrl(fileId: string): Promise<string | null> {
    const file = await this.getFile(fileId);
    if (!file.file_path) return null;
    return `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
  }

  /**
   * Downloads a file's bytes (photo/document) and returns them base64-encoded
   * for inline embedding in a `user.message` content block. Returns `null`
   * when Telegram has no `file_path` for the id (expired/invalid file).
   */
  async downloadFileAsBase64(fileId: string): Promise<{ data: string; filePath: string } | null> {
    const url = await this.getFileUrl(fileId);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) {
      throw new TelegramApiError("downloadFile", `HTTP ${res.status}`, res.status);
    }
    const buf = await res.arrayBuffer();
    const data = base64Encode(new Uint8Array(buf));
    const file = await this.getFile(fileId);
    return { data, filePath: file.file_path ?? "" };
  }
}

function base64Encode(bytes: Uint8Array): string {
  // btoa is available on both Workers and Node 18+ globalThis; avoid a
  // Buffer dependency so this stays runtime-agnostic.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
