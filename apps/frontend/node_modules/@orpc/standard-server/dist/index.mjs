import { isTypescriptObject, AsyncIteratorClass, tryDecodeURIComponent, toArray, once, isAsyncIteratorObject, replicateAsyncIterator } from '@orpc/shared';

class EventEncoderError extends TypeError {
}
class EventDecoderError extends TypeError {
}
class ErrorEvent extends Error {
  data;
  constructor(options) {
    super(options?.message ?? "An error event was received", options);
    this.data = options?.data;
  }
}

const LINE_ENDING_REGEX$1 = /\r\n|\r(?!\n)|\n/;
const MESSAGE_DELIMITER_REGEX = /(?:\r\n|\r(?!\n)|\n){2}/;
const MESSAGE_DELIMITER_GLOBAL_REGEX = /(?:\r\n|\r(?!\n)|\n){2}/g;
const CR = 13;
const LF = 10;
const SPACE = 32;
function decodeEventMessage(encoded) {
  const message = {
    data: void 0,
    event: void 0,
    id: void 0,
    retry: void 0,
    comments: []
  };
  for (const line of encoded.split(LINE_ENDING_REGEX$1)) {
    if (line === "") {
      continue;
    }
    const index = line.indexOf(":");
    const value = index === -1 ? "" : line.slice(line.charCodeAt(index + 1) === SPACE ? index + 2 : index + 1);
    if (index === 0) {
      message.comments.push(value);
      continue;
    }
    switch (index === -1 ? line : line.slice(0, index)) {
      case "data":
        message.data = message.data === void 0 ? value : `${message.data}
${value}`;
        break;
      case "event":
        message.event = value;
        break;
      case "id":
        message.id = value;
        break;
      case "retry": {
        const maybeInteger = Number.parseInt(value, 10);
        if (maybeInteger >= 0 && maybeInteger.toString() === value) {
          message.retry = maybeInteger;
        }
        break;
      }
    }
  }
  return message;
}
class EventDecoder {
  constructor(options = {}) {
    this.options = options;
  }
  pending = [];
  // Last up-to-3 characters of the pending buffer, prefixed to the next chunk
  // so a delimiter straddling the boundary is still found.
  tail = "";
  // Set when a chunk-ending '\r' was already consumed as a line ending, so a
  // leading '\n' in the next chunk is the second half of that CRLF pair.
  discardLeadingLF = false;
  feed(chunk) {
    if (chunk === "") {
      return;
    }
    if (this.discardLeadingLF) {
      this.discardLeadingLF = false;
      if (chunk.charCodeAt(0) === LF) {
        chunk = chunk.slice(1);
        if (chunk === "") {
          return;
        }
      }
    }
    const scan = this.tail + chunk;
    if (!MESSAGE_DELIMITER_REGEX.test(scan)) {
      this.pending.push(chunk);
      this.tail = scan.slice(-3);
      return;
    }
    this.pending.push(chunk);
    const buffered = this.pending.length === 1 ? chunk : this.pending.join("");
    const offset = buffered.length - scan.length;
    const parts = [];
    let start = 0;
    for (const match of scan.matchAll(MESSAGE_DELIMITER_GLOBAL_REGEX)) {
      parts.push(buffered.slice(start, offset + match.index));
      start = offset + match.index + match[0].length;
    }
    const incomplete = buffered.slice(start);
    this.pending.length = 0;
    this.tail = incomplete.slice(-3);
    if (incomplete === "") {
      this.discardLeadingLF = chunk.charCodeAt(chunk.length - 1) === CR;
    } else {
      this.pending.push(incomplete);
    }
    for (const encoded of parts) {
      const message = decodeEventMessage(encoded);
      if (this.options.onEvent) {
        this.options.onEvent(message);
      }
    }
  }
  end() {
    if (this.pending.length !== 0) {
      throw new EventDecoderError("Event Iterator ended before complete");
    }
  }
}
class EventDecoderStream extends TransformStream {
  constructor() {
    let decoder;
    super({
      start(controller) {
        decoder = new EventDecoder({
          onEvent: (event) => {
            controller.enqueue(event);
          }
        });
      },
      transform(chunk) {
        decoder.feed(chunk);
      },
      flush() {
        decoder.end();
      }
    });
  }
}

const LINE_ENDING_REGEX = /\r\n|[\n\r]/;
const LINE_ENDING_GLOBAL_REGEX = /\r\n|[\n\r]/g;
function containsLineBreak(value) {
  return LINE_ENDING_REGEX.test(value);
}
function assertEventId(id) {
  if (containsLineBreak(id)) {
    throw new EventEncoderError("Event's id must not contain a carriage return or newline character");
  }
}
function assertEventName(event) {
  if (containsLineBreak(event)) {
    throw new EventEncoderError("Event's event must not contain a carriage return or newline character");
  }
}
function assertEventRetry(retry) {
  if (!Number.isInteger(retry) || retry < 0) {
    throw new EventEncoderError("Event's retry must be a integer and >= 0");
  }
}
function assertEventComment(comment) {
  if (containsLineBreak(comment)) {
    throw new EventEncoderError("Event's comment must not contain a carriage return or newline character");
  }
}
function encodeEventData(data) {
  if (data === void 0) {
    return "";
  }
  return `data: ${data.replace(LINE_ENDING_GLOBAL_REGEX, "\ndata: ")}
`;
}
function encodeEventComments(comments) {
  let output = "";
  for (const comment of comments ?? []) {
    assertEventComment(comment);
    output += `: ${comment}
`;
  }
  return output;
}
function encodeEventMessage(message) {
  let output = "";
  output += encodeEventComments(message.comments);
  if (message.event !== void 0) {
    assertEventName(message.event);
    output += `event: ${message.event}
`;
  }
  if (message.retry !== void 0) {
    assertEventRetry(message.retry);
    output += `retry: ${message.retry}
`;
  }
  if (message.id !== void 0) {
    assertEventId(message.id);
    output += `id: ${message.id}
`;
  }
  output += encodeEventData(message.data);
  output += "\n";
  return output;
}

const EVENT_SOURCE_META_SYMBOL = Symbol("ORPC_EVENT_SOURCE_META");
function withEventMeta(container, meta) {
  if (meta.id === void 0 && meta.retry === void 0 && !meta.comments?.length) {
    return container;
  }
  if (meta.id !== void 0) {
    assertEventId(meta.id);
  }
  if (meta.retry !== void 0) {
    assertEventRetry(meta.retry);
  }
  if (meta.comments !== void 0) {
    for (const comment of meta.comments) {
      assertEventComment(comment);
    }
  }
  return new Proxy(container, {
    get(target, prop, receiver) {
      if (prop === EVENT_SOURCE_META_SYMBOL) {
        return meta;
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}
function getEventMeta(container) {
  return isTypescriptObject(container) ? Reflect.get(container, EVENT_SOURCE_META_SYMBOL) : void 0;
}

class HibernationEventIterator extends AsyncIteratorClass {
  /**
   * this property is not transferred to the client, so it should be optional for type safety
   */
  hibernationCallback;
  constructor(hibernationCallback) {
    super(async () => {
      throw new Error("Cannot iterate over hibernating iterator directly");
    }, async (reason) => {
      if (reason !== "next") {
        throw new Error("Cannot cleanup hibernating iterator directly");
      }
    });
    this.hibernationCallback = hibernationCallback;
  }
}

function generateContentDisposition(filename, disposition = "inline") {
  const encodedFileName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, '\\"');
  const encodedFilenameStar = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%(7C|60|5E)/g, (str, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return `${disposition}; filename="${encodedFileName}"; filename*=utf-8''${encodedFilenameStar}`;
}
function getFilenameFromContentDisposition(contentDisposition) {
  const encodedFilenameStarMatch = contentDisposition.match(/filename\*=(UTF-8'')?([^;]*)/i);
  if (encodedFilenameStarMatch && typeof encodedFilenameStarMatch[2] === "string") {
    return tryDecodeURIComponent(encodedFilenameStarMatch[2]);
  }
  const encodedFilenameMatch = contentDisposition.match(/filename="((?:\\"|[^"])*)"/i);
  if (encodedFilenameMatch && typeof encodedFilenameMatch[1] === "string") {
    return encodedFilenameMatch[1].replace(/\\"/g, '"');
  }
}
function mergeStandardHeaders(a, b) {
  const merged = { ...a };
  for (const key in b) {
    if (Array.isArray(b[key])) {
      merged[key] = [...toArray(merged[key]), ...b[key]];
    } else if (b[key] !== void 0) {
      if (Array.isArray(merged[key])) {
        merged[key] = [...merged[key], b[key]];
      } else if (merged[key] !== void 0) {
        merged[key] = [merged[key], b[key]];
      } else {
        merged[key] = b[key];
      }
    }
  }
  return merged;
}
function flattenHeader(header) {
  if (typeof header === "string" || header === void 0) {
    return header;
  }
  if (header.length === 0) {
    return void 0;
  }
  return header.join(", ");
}
function replicateStandardLazyResponse(response, count) {
  const replicated = [];
  let bodyPromise;
  let replicatedAsyncIteratorObjects;
  for (let i = 0; i < count; i++) {
    replicated.push({
      ...response,
      body: once(async () => {
        const body = await (bodyPromise ??= response.body());
        if (!isAsyncIteratorObject(body)) {
          return body;
        }
        replicatedAsyncIteratorObjects ??= replicateAsyncIterator(body, count);
        return replicatedAsyncIteratorObjects.shift();
      })
    });
  }
  return replicated;
}
function isEventIteratorHeaders(headers) {
  return Boolean(flattenHeader(headers["content-type"])?.startsWith("text/event-stream") && flattenHeader(headers["content-disposition"]) === void 0);
}

export { ErrorEvent, EventDecoder, EventDecoderError, EventDecoderStream, EventEncoderError, HibernationEventIterator, assertEventComment, assertEventId, assertEventName, assertEventRetry, decodeEventMessage, encodeEventComments, encodeEventData, encodeEventMessage, flattenHeader, generateContentDisposition, getEventMeta, getFilenameFromContentDisposition, isEventIteratorHeaders, mergeStandardHeaders, replicateStandardLazyResponse, withEventMeta };
