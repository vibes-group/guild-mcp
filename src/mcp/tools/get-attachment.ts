import { z } from 'zod';
import type { Attachment, Message } from 'discord.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callerFromAuth } from '../../auth/session.js';
import { fetchMessage } from '../../discord/messages.js';
import type { ToolDeps } from '../server.js';
import { errorResult, fetchErrorResult, imageResult, jsonResult, textResult } from './shared.js';

const MAX_BYTES = 10 * 1024 * 1024; // кап: base64 раздувает ~+33%, плюс лимит на размер tool-результата
const FETCH_TIMEOUT_MS = 10_000; // внешний CDN-фетч не должен подвешивать запрос бесконечно

function isTextType(mime: string | null): boolean {
  if (!mime) return false;
  return (
    mime.startsWith('text/') ||
    /^application\/(json|xml|x-yaml|yaml|javascript|csv|x-sh)(;|$)/.test(mime)
  );
}

// Форвард (messageSnapshots) уже легально виден вызвавшему — он видит сообщение-контейнер; по
// reference к оригиналу не идём: исходный канал может быть ему недоступен.
export function findAttachment(msg: Message<true>, attachmentId: string): Attachment | undefined {
  return (
    msg.attachments.get(attachmentId) ??
    [...msg.messageSnapshots.values()]
      .map((s) => s.attachments.get(attachmentId))
      .find((a) => a !== undefined)
  );
}

// Ищем вложение, при промахе один раз перечитав сообщение из REST (force): холодный/конкурентный
// кэш discord.js порой отдаёт объект без полностью загруженных messageSnapshots, и вложение форварда
// «пропадает». Обычный путь остаётся на кэше — лишний REST только при промахе.
export async function resolveAttachment(
  fetchMsg: (force: boolean) => Promise<Message<true>>,
  attachmentId: string,
): Promise<Attachment | undefined> {
  const cached = findAttachment(await fetchMsg(false), attachmentId);
  if (cached) return cached;
  return findAttachment(await fetchMsg(true), attachmentId);
}

// get_attachment — отдать САМО вложение, а не только ссылку: картинку как image-контент (Claude
// её видит), текстовый файл как текст. Гейтинг через сообщение (channelId+messageId), НЕ через
// голый URL — иначе подписанный CDN-URL обходил бы проверку доступа.
export function registerGetAttachment(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_attachment',
    {
      description:
        'Fetch an attachment\'s actual content, not just its url: images come back viewable, text ' +
        'files as text (no OCR or document parsing; files over ' +
        `${MAX_BYTES / (1024 * 1024)}MB or binary return metadata only). Identify the message by ` +
        'channelId + messageId, then pass attachmentId from its attachments[].',
      inputSchema: {
        channelId: z.string().describe('Channel id the message is in.'),
        messageId: z.string().describe('Message id.'),
        attachmentId: z.string().describe('Attachment id (from a message attachments[]).'),
      },
    },
    async (args, extra) => {
      const caller = callerFromAuth(extra.authInfo);
      let attachment;
      try {
        attachment = await resolveAttachment(
          (force) => fetchMessage(deps.discord, caller.userId, args.channelId, args.messageId, force),
          args.attachmentId,
        );
      } catch (e) {
        return fetchErrorResult(e, `Failed to fetch message ${args.messageId} in channel ${args.channelId}`);
      }
      if (!attachment) {
        return errorResult(`Attachment ${args.attachmentId} not found in message ${args.messageId}.`);
      }

      const meta = {
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        url: attachment.url,
      };
      if (attachment.size > MAX_BYTES) {
        return jsonResult({ ...meta, note: `too large to inline (> ${MAX_BYTES} bytes)` });
      }

      const isImage = attachment.contentType?.startsWith('image/') ?? false;
      const isText = isTextType(attachment.contentType);
      if (!isImage && !isText) {
        return jsonResult({ ...meta, note: 'binary attachment; fetch the url directly to download' });
      }

      let buf: Buffer;
      try {
        const res = await fetch(attachment.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return jsonResult({ ...meta, note: `fetch failed: HTTP ${res.status}` });
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        return jsonResult({ ...meta, note: `fetch failed: ${(e as Error).message}` });
      }

      if (isImage) {
        return imageResult(buf.toString('base64'), attachment.contentType ?? 'application/octet-stream');
      }
      return textResult(`Attachment ${attachment.name} (${attachment.contentType}):\n\n${buf.toString('utf8')}`);
    },
  );
}
