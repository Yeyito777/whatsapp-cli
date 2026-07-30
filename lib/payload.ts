export class PayloadUsageError extends Error {}

export interface SendStructure {
  target: string;
  file?: string;
  replyTo?: string;
}

export function parseSendStructure(args: string[]): SendStructure {
  const target = args[0];
  if (!target || target.startsWith('-')) {
    throw new PayloadUsageError('send target is required in argv');
  }

  let file: string | undefined;
  let replyTo: string | undefined;
  const inlinePayload: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--file') {
      if (file !== undefined) throw new PayloadUsageError('--file may only be specified once');
      file = args[++index];
      if (!file) throw new PayloadUsageError('missing file path after --file');
      continue;
    }
    if (arg === '--reply') {
      if (replyTo !== undefined) throw new PayloadUsageError('--reply may only be specified once');
      replyTo = args[++index];
      if (!replyTo) throw new PayloadUsageError('missing message ID after --reply');
      continue;
    }
    if (arg === '--caption') {
      throw new PayloadUsageError('file caption must be provided via stdin; --caption is not accepted');
    }
    if (arg.startsWith('-')) throw new PayloadUsageError(`unknown option: ${arg}`);
    inlinePayload.push(arg);
  }

  if (inlinePayload.length > 0) {
    const label = file ? 'file caption' : 'message text';
    throw new PayloadUsageError(`${label} must be provided via stdin; inline text is not accepted`);
  }
  if (file && replyTo) {
    throw new PayloadUsageError('--reply is not supported with --file');
  }

  return { target, ...(file ? { file } : {}), ...(replyTo ? { replyTo } : {}) };
}

export function decodeExactUtf8(
  bytes: Uint8Array,
  label: string,
  { required = true }: { required?: boolean } = {},
): string | undefined {
  if (bytes.byteLength === 0) {
    if (required) throw new PayloadUsageError(`${label} is required on stdin`);
    return undefined;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PayloadUsageError(`${label} on stdin must be valid UTF-8`);
  }
}

export async function readStdinBytes(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
