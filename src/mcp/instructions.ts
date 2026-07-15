// Server-level guidance sent to the client in the MCP initialize handshake and shown to the model.
// Scope: only what a per-tool description cannot own — the access model, the glossary of output
// fields shared across the message tools, and the compact/full detail-level split. Tool selection
// and per-tool input contracts live in each tool's description. Keep the field list in sync with
// shared.ts (message card) and search.ts (lighter search hit).

export const SERVER_INSTRUCTIONS = `Read-only access to Discord, gated by your Discord roles: message and channel tools expose only the channels you may see; member tools only the servers you share with this bot. Everything else is refused.

Message-card fields (get_messages, get_message, get_pinned; search_messages returns a lighter subset):
- content: raw text (mentions as <@id>). cleanContent: mentions/channels/emoji resolved — prefer for display.
- author: username=@handle, globalName=account name, nickname=per-server name, displayName=shown in UI. bot/webhookId mark non-human authors.
- Timestamps are ISO 8601. editedAt is set if the message was edited; only the current text is kept, no history.
- Enum fields carry the name, not a number (e.g. type; reference.type is Default for a reply or Forward).
- reference: present on a reply/forward; messageId/channelId point at the target (may be another channel).
- forwardedMessages: content of forwarded messages (a forward's own content is empty).
- attachments: url is signed and expires ~24h — fetch promptly or use get_attachment; duration (seconds) marks a voice message.
- hasThread/threadId: message started a thread; read it with get_messages(channelId=threadId).

Detail levels: get_messages and get_pinned return compact cards — embeds, polls and forwards summarized, replies as ids. get_message returns one card in full: embed fields, poll votes, forwarded content, reply preview.`;
