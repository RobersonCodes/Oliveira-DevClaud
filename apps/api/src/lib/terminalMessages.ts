import { z } from 'zod';

type TerminalRawData = Buffer | ArrayBuffer | Buffer[];

const terminalClientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65536) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(120)
  })
]);

function rawDataToText(raw: TerminalRawData) {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return Buffer.from(new Uint8Array(raw)).toString('utf8');
}

export function parseTerminalClientMessage(raw: TerminalRawData, isBinary: boolean) {
  const text = rawDataToText(raw);
  if (isBinary || !text.trimStart().startsWith('{')) return { type: 'input' as const, data: text };
  return terminalClientEventSchema.parse(JSON.parse(text));
}
