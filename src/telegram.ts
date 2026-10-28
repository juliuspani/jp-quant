import { log } from './log.ts';
import type { Notifier } from './types.ts';
import { errMsg, sleep } from './util.ts';

export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    log('info', 'aviso', text.replaceAll('\n', ' | '));
  }
}

export type CommandHandler = (command: string) => Promise<string | null> | string | null;

interface Update {
  update_id: number;
  message?: { date: number; text?: string; chat: { id: number } };
}

/** Órdenes recibidas mientras el bot estaba apagado no deben ejecutarse al arrancar. */
const MAX_COMMAND_AGE_S = 120;

export class TelegramNotifier implements Notifier {
  private base: string;
  private chatId: string | undefined;

  constructor(token: string, chatId: string | undefined) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.chatId = chatId;
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  /** Nunca lanza: un fallo de Telegram no debe interrumpir la operativa. */
  async send(text: string): Promise<void> {
    log('info', 'aviso', text.replaceAll('\n', ' | '));
    if (!this.chatId) return;
    try {
      await this.call('sendMessage', { chat_id: this.chatId, text, disable_web_page_preview: true }, 15_000);
    } catch (e) {
      log('warn', 'telegram', `No se pudo enviar el aviso: ${errMsg(e)}`);
    }
  }

  /**
   * Escucha órdenes por long polling hasta que se aborte la señal. Solo
   * atiende al chat autorizado: cualquier otro remitente se ignora.
   */
  async listen(handler: CommandHandler, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          const from = String(msg.chat.id);
          if (!this.chatId) {
            log('info', 'telegram', `Mensaje recibido del chat ${from}. Añade TELEGRAM_CHAT_ID=${from} al archivo .env y reinicia para autorizarlo.`);
            continue;
          }
          if (from !== this.chatId) {
            log('warn', 'telegram', `Mensaje ignorado de un chat no autorizado (${from})`);
            continue;
          }
          if (Date.now() / 1000 - msg.date > MAX_COMMAND_AGE_S) continue;
          const command = msg.text.trim().split(/\s+/)[0]!.split('@')[0]!.toLowerCase();
          const reply = await handler(command);
          if (reply) await this.send(reply);
        }
      } catch (e) {
        if (signal.aborted) return;
        log('warn', 'telegram', `Error escuchando órdenes: ${errMsg(e)}`);
        await sleep(10_000);
      }
    }
  }
}
