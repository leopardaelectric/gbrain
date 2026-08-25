/**
 * Block-format conversation normalizer.
 *
 * Some chat exports — notably the Slack collector gbrain's own ingestion
 * uses — emit a HEADER + indented-body BLOCK per message instead of the
 * single-line `**Name** (time): body` shape the built-in patterns
 * (`builtins.ts`) recognize:
 *
 *     - **Theo** (Mon 11:18)
 *       Hey everyone — quick update on the renewal.
 *
 *       Second paragraph of the same message.
 *     - **Juan** (Mon 11:20)
 *       Reply body...
 *
 * None of the 14 line-oriented built-ins match this: a leading `- ` list
 * marker, a day-of-week + time with no trailing colon, and the message body on
 * the following indented lines. Result: `phase: 'no_match'`, zero messages,
 * and the whole comms corpus is silently un-extractable (facts stay empty →
 * `find_trajectory` returns nothing).
 *
 * This collapses each block into the canonical `**Name** (HH:MM): <body joined
 * to one line>` shape so the existing `bold-paren-time` pattern matches; the
 * per-message date fills in downstream via `fallbackDate` (the page date).
 *
 * STRICT no-op unless the block signature is present: the header regex requires
 * the paren-group to END the line (no inline `: body`), which is exactly what
 * the single-line patterns always produce — so feeding already-canonical
 * content through this function returns it unchanged.
 */

// `- **Name** (Mon 11:18)` / `- **Name** (11:18 AM)` / `- **Name** (16:36)`.
// Day-of-week optional; 12h/24h time; optional am/pm; the line ENDS at the
// close paren (no inline `: body` — that is what distinguishes a block header
// from the single-line `**Name** (time): body` patterns).
const BLOCK_HEADER =
  /^\s*-\s+\*\*(.+?)\*\*\s+\((?:[A-Za-z]{2,9}\.?\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\)\s*$/;

// Daily Slack archive pages use one Markdown section per message, followed by
// collector metadata and then the message body. Require both the ISO heading
// and Slack-specific metadata before normalizing so ordinary dated documents
// remain untouched.
const SLACK_ARCHIVE_HEADER =
  /^##\s+(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?Z\s*$/;

function looksLikeSlackArchiveConversation(body: string): boolean {
  return (
    SLACK_ARCHIVE_HEADER.test(body.split('\n').find((line) => SLACK_ARCHIVE_HEADER.test(line)) ?? '') &&
    /^slack_ts:\s*\S+/m.test(body) &&
    /^(?:user_display|user):\s*\S+/m.test(body)
  );
}

function normalizeSlackArchiveConversation(body: string): string {
  if (!looksLikeSlackArchiveConversation(body)) return body;

  const out: string[] = [];
  let current: {
    date: string;
    time: string;
    speaker?: string;
    sawMetadata: boolean;
    inBody: boolean;
    bodyParts: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    const text = current.bodyParts.join(' ').replace(/\s+/g, ' ').trim();
    if (current.speaker && text) {
      out.push(`**${current.speaker}** (${current.date} ${current.time}): ${text}`);
    }
    current = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const header = SLACK_ARCHIVE_HEADER.exec(line);
    if (header) {
      flush();
      current = {
        date: header[1],
        time: `${header[2]}:${header[3]}`,
        sawMetadata: false,
        inBody: false,
        bodyParts: [],
      };
      continue;
    }
    if (!current) continue;

    if (!current.inBody) {
      const metadata = /^([a-z][a-z0-9_]*):\s*(.*)$/.exec(line);
      if (metadata) {
        current.sawMetadata = true;
        if (metadata[1] === 'user_display' && metadata[2].trim()) {
          current.speaker = metadata[2].trim();
        } else if (metadata[1] === 'user' && !current.speaker && metadata[2].trim()) {
          current.speaker = metadata[2].trim();
        }
        continue;
      }
      if (!line.trim() && current.sawMetadata) {
        current.inBody = true;
      }
      continue;
    }

    if (line.trim()) current.bodyParts.push(line.trim());
  }
  flush();

  return out.length > 0 ? out.join('\n') : body;
}

/** True when at least one line is a block-format message header. */
export function looksLikeBlockConversation(body: string): boolean {
  for (const line of body.split('\n')) {
    if (BLOCK_HEADER.test(line)) return true;
  }
  return false;
}

function to24h(hour: number, ampm?: string): number {
  if (!ampm) return hour;
  const lower = ampm.toLowerCase();
  if (lower === 'pm' && hour < 12) return hour + 12;
  if (lower === 'am' && hour === 12) return 0;
  return hour;
}

/**
 * Collapse block-format messages into canonical single-line `**Name** (HH:MM):
 * body` lines. Returns `body` unchanged when no block header is present.
 */
export function normalizeBlockConversation(body: string): string {
  const archiveNormalized = normalizeSlackArchiveConversation(body);
  if (archiveNormalized !== body) return archiveNormalized;
  if (!looksLikeBlockConversation(body)) return body;

  const lines = body.split('\n');
  const out: string[] = [];
  let current: { name: string; time: string } | null = null;
  let bodyParts: string[] = [];

  const flush = () => {
    if (current) {
      const text = bodyParts.join(' ').replace(/\s+/g, ' ').trim();
      out.push(`**${current.name}** (${current.time}): ${text}`);
    }
    current = null;
    bodyParts = [];
  };

  for (const line of lines) {
    const m = BLOCK_HEADER.exec(line);
    if (m) {
      flush();
      const hour = to24h(parseInt(m[2], 10), m[4]);
      const time = `${String(hour).padStart(2, '0')}:${m[3]}`;
      current = { name: m[1].trim(), time };
    } else if (current) {
      // Body line of the current message. Drop blank lines; keep the rest.
      const trimmed = line.trim();
      if (trimmed) bodyParts.push(trimmed);
    }
    // Lines before the first header (page title, leading blanks) are dropped —
    // they never matched a pattern anyway.
  }
  flush();

  return out.length > 0 ? out.join('\n') : body;
}
