/**
 * Vendored from the Pi coding agent package (its dist/core/tools/truncate.js, MIT).
 * Only the pieces the autoresearch loop uses are kept: constants, formatSize and
 * truncateTail. Behaviour is pinned by tests/core/truncate.test.mjs, which compares
 * this copy with the Pi implementation on the same fixtures.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    else {
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
}
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const totalBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;
    // Check if no truncation needed
    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines,
            totalBytes,
            outputLines: totalLines,
            outputBytes: totalBytes,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
        };
    }
    // Work backwards from the end
    const outputLinesArr: string[] = [];
    let outputBytesCount = 0;
    let truncatedBy: TruncationResult["truncatedBy"] = "lines";
    let lastLinePartial = false;
    for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline
        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = "bytes";
            // Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
            // take the end of the line (partial)
            if (outputLinesArr.length === 0) {
                const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
                outputLinesArr.unshift(truncatedLine);
                outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
                lastLinePartial = true;
            }
            break;
        }
        outputLinesArr.unshift(line);
        outputBytesCount += lineBytes;
    }
    // If we exited due to line limit
    if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
        truncatedBy = "lines";
    }
    const outputContent = outputLinesArr.join("\n");
    const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");
    return {
        content: outputContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: outputLinesArr.length,
        outputBytes: finalOutputBytes,
        lastLinePartial,
        firstLineExceedsLimit: false,
        maxLines,
        maxBytes,
    };
}
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
    const buf = Buffer.from(str, "utf-8");
    if (buf.length <= maxBytes) {
        return str;
    }
    // Start from the end, skip maxBytes back
    let start = buf.length - maxBytes;
    // Find a valid UTF-8 boundary (start of a character)
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
        start++;
    }
    return buf.slice(start).toString("utf-8");
}
