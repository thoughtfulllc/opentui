const std = @import("std");
const Allocator = std.mem.Allocator;
const rope_mod = @import("rope.zig");
const buffer = @import("buffer.zig");
const mem_registry_mod = @import("mem-registry.zig");

const gp = @import("grapheme.zig");

const utf8 = @import("utf8.zig");

pub const RGBA = buffer.RGBA;
pub const TextSelection = buffer.TextSelection;

pub const TextBufferError = error{
    OutOfMemory,
    InvalidDimensions,
    InvalidIndex,
    InvalidId,
    InvalidMemId,
};

const MemRegistry = mem_registry_mod.MemRegistry;

pub const WrapMode = enum {
    none,
    char,
    word,
};

pub const ChunkFitResult = struct {
    char_count: u32,
    width: u32,
};

pub const LayoutCacheMode = enum {
    full_cache,
    windowed,
};

pub const LayoutSpanScratch = struct {
    slots: [LAYOUT_WINDOW_SLOTS][LAYOUT_WINDOW_MAX_SPANS]utf8.GraphemeSpan = undefined,
    lens: [LAYOUT_WINDOW_SLOTS]usize = [_]usize{0} ** LAYOUT_WINDOW_SLOTS,

    pub fn reset(self: *LayoutSpanScratch) void {
        self.lens = [_]usize{0} ** LAYOUT_WINDOW_SLOTS;
    }
};

pub const LAYOUT_FULL_CACHE_MAX_CHUNK_BYTES: u32 = 8 * 1024;
pub const LAYOUT_FULL_CACHE_MAX_SPANS: u32 = 2048;
pub const LAYOUT_ASCII_FULL_CACHE_MAX_CHUNK_BYTES: u32 = 1024;

pub const LAYOUT_WINDOW_BYTES: u32 = 2 * 1024;
pub const LAYOUT_WINDOW_MAX_SPANS: u32 = 1024;
pub const LAYOUT_WINDOW_SLOTS: u8 = 2;

threadlocal var layout_cache_mode_override_for_testing: ?LayoutCacheMode = null;

pub fn setLayoutCacheModeOverrideForTesting(mode: ?LayoutCacheMode) void {
    layout_cache_mode_override_for_testing = mode;
}

/// A chunk represents a contiguous sequence of UTF-8 bytes from a specific memory buffer
pub const TextChunk = struct {
    mem_id: u8,
    byte_start: u32,
    byte_end: u32,
    width: u16,
    flags: u8 = 0,
    layout_spans: ?[]utf8.GraphemeSpan = null,
    layout_cache_allocator: ?Allocator = null,
    layout_cache_tab_width: u8 = 0,
    layout_cache_width_method: utf8.WidthMethod = .unicode,
    layout_cache_valid: bool = false,
    layout_cache_mode: LayoutCacheMode = .full_cache,

    pub const Flags = struct {
        pub const ASCII_ONLY: u8 = 0b00000001; // Printable ASCII only (32..126).
    };

    pub const SpanConsumer = *const fn (ctx: *anyopaque, spans: []const utf8.GraphemeSpan) anyerror!void;

    pub fn isAsciiOnly(self: *const TextChunk) bool {
        return (self.flags & Flags.ASCII_ONLY) != 0;
    }

    fn hasLayoutCacheFor(self: *const TextChunk, tabwidth: u8, width_method: utf8.WidthMethod) bool {
        return self.layout_cache_valid and
            self.layout_spans != null and
            self.layout_cache_tab_width == tabwidth and
            self.layout_cache_width_method == width_method;
    }

    fn clearLayoutCache(self: *TextChunk) void {
        if (self.layout_spans) |spans| {
            if (self.layout_cache_allocator) |cache_allocator| {
                cache_allocator.free(spans);
            }
        }

        self.layout_spans = null;
        self.layout_cache_allocator = null;
        self.layout_cache_valid = false;
    }

    fn cacheLayoutScanResult(
        self: *TextChunk,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scan_result: *const utf8.LayoutScanResult,
    ) TextBufferError!void {
        self.clearLayoutCache();

        const spans = try allocator.alloc(utf8.GraphemeSpan, scan_result.spans.items.len);
        @memcpy(spans, scan_result.spans.items);

        self.layout_spans = spans;
        self.layout_cache_allocator = allocator;
        self.layout_cache_tab_width = tabwidth;
        self.layout_cache_width_method = width_method;
        self.layout_cache_valid = true;
        self.layout_cache_mode = .full_cache;
    }

    fn resolveLayoutCacheMode(self: *const TextChunk, byte_len: u32, span_count: usize) LayoutCacheMode {
        if (layout_cache_mode_override_for_testing) |forced_mode| {
            return forced_mode;
        }

        if (self.isAsciiOnly()) {
            return if (byte_len <= LAYOUT_ASCII_FULL_CACHE_MAX_CHUNK_BYTES) .full_cache else .windowed;
        }

        if (byte_len > LAYOUT_FULL_CACHE_MAX_CHUNK_BYTES) {
            return .windowed;
        }

        if (span_count > LAYOUT_FULL_CACHE_MAX_SPANS) {
            return .windowed;
        }

        return .full_cache;
    }

    fn ensureLayoutCacheState(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError!void {
        const forced_mode = layout_cache_mode_override_for_testing;

        if (forced_mode == .windowed) {
            self.layout_cache_tab_width = tabwidth;
            self.layout_cache_width_method = width_method;
            self.clearLayoutCache();
            self.layout_cache_mode = .windowed;
            return;
        }

        if (forced_mode != .full_cache and self.hasLayoutCacheFor(tabwidth, width_method)) {
            self.layout_cache_mode = .full_cache;
            return;
        }

        const chunk_bytes = self.getBytes(mem_registry);
        const byte_len: u32 = @intCast(chunk_bytes.len);
        self.layout_cache_tab_width = tabwidth;
        self.layout_cache_width_method = width_method;

        if (forced_mode == .full_cache) {
            var forced_scan = utf8.LayoutScanResult.init(std.heap.page_allocator);
            defer forced_scan.deinit();

            try utf8.scanLayout(chunk_bytes, tabwidth, self.isAsciiOnly(), width_method, &forced_scan);
            try self.cacheLayoutScanResult(allocator, tabwidth, width_method, &forced_scan);
            return;
        }

        if (self.isAsciiOnly()) {
            if (byte_len <= LAYOUT_ASCII_FULL_CACHE_MAX_CHUNK_BYTES) {
                var ascii_scan = utf8.LayoutScanResult.init(std.heap.page_allocator);
                defer ascii_scan.deinit();

                try utf8.scanLayout(chunk_bytes, tabwidth, true, width_method, &ascii_scan);
                try self.cacheLayoutScanResult(allocator, tabwidth, width_method, &ascii_scan);
                return;
            }

            self.clearLayoutCache();
            self.layout_cache_mode = .windowed;
            return;
        }

        if (byte_len > LAYOUT_FULL_CACHE_MAX_CHUNK_BYTES) {
            self.clearLayoutCache();
            self.layout_cache_mode = .windowed;
            return;
        }

        var scan_result = utf8.LayoutScanResult.init(std.heap.page_allocator);
        defer scan_result.deinit();

        try utf8.scanLayout(chunk_bytes, tabwidth, false, width_method, &scan_result);
        const mode = self.resolveLayoutCacheMode(byte_len, scan_result.spans.items.len);
        if (mode == .full_cache) {
            try self.cacheLayoutScanResult(allocator, tabwidth, width_method, &scan_result);
            return;
        }

        self.clearLayoutCache();
        self.layout_cache_mode = .windowed;
    }

    fn withLayoutSpans(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        cache_allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        _ = cache_allocator;

        if (layout_cache_mode_override_for_testing) |forced_mode| {
            self.layout_cache_tab_width = tabwidth;
            self.layout_cache_width_method = width_method;
            if (forced_mode == .windowed) {
                self.clearLayoutCache();
            }
            self.layout_cache_mode = forced_mode;
        } else {
            self.layout_cache_tab_width = tabwidth;
            self.layout_cache_width_method = width_method;

            if (!self.layout_cache_valid) {
                const byte_len: u32 = @intCast(self.getBytes(mem_registry).len);
                if (self.isAsciiOnly()) {
                    self.layout_cache_mode = if (byte_len <= LAYOUT_ASCII_FULL_CACHE_MAX_CHUNK_BYTES) .full_cache else .windowed;
                } else {
                    self.layout_cache_mode = if (byte_len <= LAYOUT_FULL_CACHE_MAX_CHUNK_BYTES) .full_cache else .windowed;
                }
            }
        }

        if (self.hasLayoutCacheFor(tabwidth, width_method)) {
            const spans = self.layout_spans orelse &[_]utf8.GraphemeSpan{};
            try consumer(ctx, spans);
            return;
        }

        try self.iterateWindowedSpans(mem_registry, tabwidth, width_method, scratch, ctx, consumer);
    }

    fn withLayoutSpansNoBreaks(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        cache_allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        _ = cache_allocator;

        if (layout_cache_mode_override_for_testing) |forced_mode| {
            self.layout_cache_tab_width = tabwidth;
            self.layout_cache_width_method = width_method;
            if (forced_mode == .windowed) {
                self.clearLayoutCache();
            }
            self.layout_cache_mode = forced_mode;
        } else {
            self.layout_cache_tab_width = tabwidth;
            self.layout_cache_width_method = width_method;

            if (!self.layout_cache_valid) {
                const byte_len: u32 = @intCast(self.getBytes(mem_registry).len);
                if (self.isAsciiOnly()) {
                    self.layout_cache_mode = if (byte_len <= LAYOUT_ASCII_FULL_CACHE_MAX_CHUNK_BYTES) .full_cache else .windowed;
                } else {
                    self.layout_cache_mode = if (byte_len <= LAYOUT_FULL_CACHE_MAX_CHUNK_BYTES) .full_cache else .windowed;
                }
            }
        }

        if (self.hasLayoutCacheFor(tabwidth, width_method)) {
            const spans = self.layout_spans orelse &[_]utf8.GraphemeSpan{};
            try consumer(ctx, spans);
            return;
        }

        try self.iterateWindowedSpansNoBreaks(mem_registry, tabwidth, width_method, scratch, ctx, consumer);
    }

    fn withLayoutSpansCached(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        cache_allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        try self.ensureLayoutCacheState(mem_registry, cache_allocator, tabwidth, width_method);

        if (self.layout_cache_mode == .full_cache) {
            const spans = self.layout_spans orelse &[_]utf8.GraphemeSpan{};
            try consumer(ctx, spans);
            return;
        }

        try self.iterateWindowedSpans(mem_registry, tabwidth, width_method, scratch, ctx, consumer);
    }

    fn iterateWindowedSpans(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        return self.iterateWindowedSpansInternal(mem_registry, tabwidth, width_method, scratch, ctx, consumer, true);
    }

    fn iterateWindowedSpansNoBreaks(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        return self.iterateWindowedSpansInternal(mem_registry, tabwidth, width_method, scratch, ctx, consumer, false);
    }

    fn iterateWindowedSpansInternal(
        self: *TextChunk,
        mem_registry: *const MemRegistry,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
        track_breaks: bool,
    ) anyerror!void {
        const chunk_bytes = self.getBytes(mem_registry);
        if (chunk_bytes.len == 0) {
            return consumer(ctx, &[_]utf8.GraphemeSpan{});
        }

        scratch.reset();

        const slot_count: usize = @intCast(LAYOUT_WINDOW_SLOTS);
        var slot_idx: usize = 0;
        var previous_slot_idx: usize = 0;
        var has_previous = false;
        var cursor = utf8.LayoutScanCursor{};
        const col_limit: u32 = self.width;

        if (!track_breaks) {
            while (true) {
                const batch = try utf8.scanLayoutNextBatchNoBreaks(
                    chunk_bytes,
                    tabwidth,
                    self.isAsciiOnly(),
                    width_method,
                    &cursor,
                    scratch.slots[0][0..],
                );

                var emit_len = batch.spans.len;
                var reached_col_limit = false;
                if (cursor.col_offset > col_limit) {
                    for (batch.spans, 0..) |span, idx| {
                        const span_end_col = span.col_start + span.col_width;
                        if (span_end_col > col_limit) {
                            emit_len = idx;
                            reached_col_limit = true;
                            break;
                        }
                    }
                }

                if (emit_len > 0) {
                    try consumer(ctx, scratch.slots[0][0..emit_len]);
                }

                if (batch.done or reached_col_limit) {
                    break;
                }

                if (batch.spans.len == 0) {
                    return error.InvalidDimensions;
                }
            }

            return;
        }

        while (true) {
            const batch = try utf8.scanLayoutNextBatch(
                chunk_bytes,
                tabwidth,
                self.isAsciiOnly(),
                width_method,
                &cursor,
                scratch.slots[slot_idx][0..],
            );

            var emit_len = batch.spans.len;
            var reached_col_limit = false;
            if (cursor.col_offset > col_limit) {
                for (batch.spans, 0..) |span, idx| {
                    const span_end_col = span.col_start + span.col_width;
                    if (span_end_col > col_limit) {
                        emit_len = idx;
                        reached_col_limit = true;
                        break;
                    }
                }
            }

            scratch.lens[slot_idx] = emit_len;

            if (has_previous) {
                const previous_spans = scratch.slots[previous_slot_idx][0..scratch.lens[previous_slot_idx]];
                const current_spans = scratch.slots[slot_idx][0..scratch.lens[slot_idx]];
                patchWindowBoundaryScriptTransition(chunk_bytes, previous_spans, current_spans);
                if (previous_spans.len > 0) {
                    try consumer(ctx, previous_spans);
                }
            } else {
                has_previous = true;
            }

            previous_slot_idx = slot_idx;
            slot_idx = (slot_idx + 1) % slot_count;

            if (batch.done or reached_col_limit) {
                break;
            }

            if (batch.spans.len == 0) {
                return error.InvalidDimensions;
            }
        }

        if (has_previous) {
            const previous_spans = scratch.slots[previous_slot_idx][0..scratch.lens[previous_slot_idx]];
            if (previous_spans.len > 0) {
                try consumer(ctx, previous_spans);
            }
        }
    }

    fn firstCodepointInSpan(chunk_bytes: []const u8, span: utf8.GraphemeSpan) ?u21 {
        const start: usize = @intCast(span.byte_start);
        if (start >= chunk_bytes.len) {
            return null;
        }

        const b0 = chunk_bytes[start];
        if (b0 < 0x80) {
            return @intCast(b0);
        }

        const dec = utf8.decodeUtf8Unchecked(chunk_bytes, start);
        if (start + dec.len > chunk_bytes.len) {
            return null;
        }

        return dec.cp;
    }

    fn patchWindowBoundaryScriptTransition(
        chunk_bytes: []const u8,
        previous_spans: []utf8.GraphemeSpan,
        current_spans: []const utf8.GraphemeSpan,
    ) void {
        if (previous_spans.len == 0 or current_spans.len == 0) {
            return;
        }

        var previous_last = &previous_spans[previous_spans.len - 1];
        if (previous_last.break_after != .none) {
            return;
        }

        const previous_cp = firstCodepointInSpan(chunk_bytes, previous_last.*) orelse return;
        const current_cp = firstCodepointInSpan(chunk_bytes, current_spans[0]) orelse return;

        if (utf8.isScriptTransitionBoundary(previous_cp, current_cp)) {
            previous_last.break_after = .script_transition;
        }
    }

    pub fn getLayoutCacheMode(self: *const TextChunk) LayoutCacheMode {
        return self.layout_cache_mode;
    }

    /// Streams canonical layout spans to `consumer`.
    ///
    /// - full_cache mode: emits the borrowed cached slice once.
    /// - windowed mode: emits bounded windows in scan order.
    pub fn forEachLayoutSpans(
        self: *const TextChunk,
        mem_registry: *const MemRegistry,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        const mut_self = @constCast(self);
        try mut_self.withLayoutSpans(mem_registry, allocator, tabwidth, width_method, scratch, ctx, consumer);
    }

    pub fn forEachLayoutSpansNoBreaks(
        self: *const TextChunk,
        mem_registry: *const MemRegistry,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        const mut_self = @constCast(self);
        try mut_self.withLayoutSpansNoBreaks(mem_registry, allocator, tabwidth, width_method, scratch, ctx, consumer);
    }

    pub fn forEachLayoutSpansCached(
        self: *const TextChunk,
        mem_registry: *const MemRegistry,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
        scratch: *LayoutSpanScratch,
        ctx: *anyopaque,
        consumer: SpanConsumer,
    ) anyerror!void {
        const mut_self = @constCast(self);
        try mut_self.withLayoutSpansCached(mem_registry, allocator, tabwidth, width_method, scratch, ctx, consumer);
    }

    /// Returns canonical layout spans.
    /// - full_cache mode: borrowed cache slice (do not free)
    /// - windowed mode: owned materialized slice allocated from `allocator` (caller owns and must free)
    pub fn getLayoutSpans(
        self: *const TextChunk,
        mem_registry: *const MemRegistry,
        allocator: Allocator,
        tabwidth: u8,
        width_method: utf8.WidthMethod,
    ) TextBufferError![]const utf8.GraphemeSpan {
        const mut_self = @constCast(self);

        try mut_self.ensureLayoutCacheState(mem_registry, allocator, tabwidth, width_method);
        if (mut_self.layout_cache_mode == .full_cache) {
            return mut_self.layout_spans orelse &[_]utf8.GraphemeSpan{};
        }

        const Context = struct {
            allocator: Allocator,
            spans: *std.ArrayListUnmanaged(utf8.GraphemeSpan),

            fn consume(ctx_ptr: *anyopaque, spans: []const utf8.GraphemeSpan) TextBufferError!void {
                const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));
                try ctx.spans.appendSlice(ctx.allocator, spans);
            }
        };

        var spans: std.ArrayListUnmanaged(utf8.GraphemeSpan) = .{};
        errdefer spans.deinit(allocator);

        var ctx = Context{
            .allocator = allocator,
            .spans = &spans,
        };
        var scratch = LayoutSpanScratch{};
        mut_self.iterateWindowedSpans(mem_registry, tabwidth, width_method, &scratch, &ctx, Context.consume) catch |err| {
            return switch (err) {
                error.OutOfMemory => TextBufferError.OutOfMemory,
                error.InvalidDimensions => TextBufferError.InvalidDimensions,
                error.InvalidIndex => TextBufferError.InvalidIndex,
                error.InvalidId => TextBufferError.InvalidId,
                error.InvalidMemId => TextBufferError.InvalidMemId,
                else => TextBufferError.OutOfMemory,
            };
        };

        return try spans.toOwnedSlice(allocator);
    }

    pub fn empty() TextChunk {
        return .{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 0,
            .width = 0,
        };
    }

    pub fn is_empty(self: *const TextChunk) bool {
        return self.width == 0;
    }

    pub fn getBytes(self: *const TextChunk, mem_registry: *const MemRegistry) []const u8 {
        const mem_buf = mem_registry.get(self.mem_id) orelse return &[_]u8{};
        return mem_buf[self.byte_start..self.byte_end];
    }
};

/// A highlight represents a styled region on a line
pub const Highlight = struct {
    col_start: u32,
    col_end: u32,
    style_id: u32,
    priority: u8,
    hl_ref: u16 = 0,
};

/// Pre-computed style span for efficient rendering
/// Represents a contiguous region with a single style
pub const StyleSpan = struct {
    col: u32,
    style_id: u32,
    next_col: u32,
};

/// A segment in the unified rope - either text content or a line break marker
pub const Segment = union(enum) {
    text: TextChunk,
    brk: void,
    linestart: void,

    /// Define which union tags are markers (for O(1) line lookup)
    pub const MarkerTypes = &[_]std.meta.Tag(Segment){ .brk, .linestart };

    /// Metrics for aggregation in the rope tree
    /// These enable O(log n) row/col coordinate mapping and efficient line queries
    pub const Metrics = struct {
        total_width: u32 = 0,
        total_bytes: u32 = 0,
        linestart_count: u32 = 0,
        newline_count: u32 = 0,
        max_line_width: u32 = 0,
        /// Whether all text segments in subtree are ASCII-only (for fast wrapping paths)
        ascii_only: bool = true,

        pub fn add(self: *Metrics, other: Metrics) void {
            self.total_width += other.total_width;
            self.total_bytes += other.total_bytes;
            self.linestart_count += other.linestart_count;
            self.newline_count += other.newline_count;

            self.max_line_width = @max(self.max_line_width, other.max_line_width);

            self.ascii_only = self.ascii_only and other.ascii_only;
        }

        /// Get the balancing weight for the rope
        /// We use total_width + newline_count to give each break a weight of 1
        /// This eliminates boundary ambiguity in coordinate/offset conversions
        pub fn weight(self: *const Metrics) u32 {
            return self.total_width + self.newline_count;
        }
    };

    /// Measure this segment to produce its metrics
    pub fn measure(self: *const Segment) Metrics {
        return switch (self.*) {
            .text => |chunk| blk: {
                const is_ascii = (chunk.flags & TextChunk.Flags.ASCII_ONLY) != 0;
                const byte_len = chunk.byte_end - chunk.byte_start;
                break :blk Metrics{
                    .total_width = chunk.width,
                    .total_bytes = byte_len,
                    .linestart_count = 0,
                    .newline_count = 0,
                    .max_line_width = chunk.width,
                    .ascii_only = is_ascii,
                };
            },
            .brk => Metrics{
                .total_width = 0,
                .total_bytes = 0,
                .linestart_count = 0,
                .newline_count = 1,
                .max_line_width = 0,
                .ascii_only = true,
            },
            .linestart => Metrics{
                .total_width = 0,
                .total_bytes = 0,
                .linestart_count = 1,
                .newline_count = 0,
                .max_line_width = 0,
                .ascii_only = true,
            },
        };
    }

    pub fn empty() Segment {
        return .{ .text = TextChunk.empty() };
    }

    pub fn is_empty(self: *const Segment) bool {
        return switch (self.*) {
            .text => |chunk| chunk.is_empty(),
            .brk => false,
            .linestart => false,
        };
    }

    pub fn getBytes(self: *const Segment, mem_registry: *const MemRegistry) []const u8 {
        return switch (self.*) {
            .text => |chunk| chunk.getBytes(mem_registry),
            .brk => &[_]u8{},
            .linestart => &[_]u8{},
        };
    }

    pub fn isBreak(self: *const Segment) bool {
        return switch (self.*) {
            .brk => true,
            else => false,
        };
    }

    pub fn isLineStart(self: *const Segment) bool {
        return switch (self.*) {
            .linestart => true,
            else => false,
        };
    }

    pub fn isText(self: *const Segment) bool {
        return switch (self.*) {
            .text => true,
            else => false,
        };
    }

    pub fn asText(self: *const Segment) ?*const TextChunk {
        return switch (self.*) {
            .text => |*chunk| chunk,
            else => null,
        };
    }

    /// Two text chunks can be merged if they reference contiguous memory in the same buffer
    pub fn canMerge(left: *const Segment, right: *const Segment) bool {
        if (!left.isText() or !right.isText()) return false;

        const left_chunk = left.asText() orelse return false;
        const right_chunk = right.asText() orelse return false;

        if (left_chunk.mem_id != right_chunk.mem_id) return false;
        if (left_chunk.byte_end != right_chunk.byte_start) return false;
        if (left_chunk.flags != right_chunk.flags) return false;

        return true;
    }

    pub fn merge(allocator: Allocator, left: *const Segment, right: *const Segment) Segment {
        _ = allocator;

        const left_chunk = left.asText().?;
        const right_chunk = right.asText().?;

        // TODO: could clear the caches on the original chunks,
        // as the original chunks are only kept for history purposes.

        return Segment{
            .text = TextChunk{
                .mem_id = left_chunk.mem_id,
                .byte_start = left_chunk.byte_start,
                .byte_end = right_chunk.byte_end,
                .width = left_chunk.width + right_chunk.width,
                .flags = left_chunk.flags,
            },
        };
    }

    /// Boundary normalization action
    pub const BoundaryAction = struct {
        delete_left: bool = false,
        delete_right: bool = false,
        insert_between: []const Segment = &[_]Segment{},
    };

    /// Rewrite boundary between two adjacent segments to enforce invariants
    ///
    /// Document invariants enforced at join boundaries:
    /// - Every line starts with a linestart marker
    /// - Line breaks must be followed by linestart markers
    /// - No duplicate linestart markers (deduplicated automatically)
    /// - When joining lines, orphaned linestart markers are removed
    /// - Empty lines are represented as [linestart, brk] with no text, or [linestart] if final
    /// - Consecutive breaks [brk, brk] get a linestart inserted between (empty line)
    ///
    /// Rules applied locally at O(log n) join points:
    /// - [linestart, linestart] → delete right (dedup)
    /// - [brk, text] → insert linestart between (ensure line starts with marker)
    /// - [brk, brk] → insert linestart between (represents empty line)
    /// - [text, linestart] → delete right (remove orphaned linestart when joining lines)
    ///
    /// Valid patterns (no action needed):
    /// - [text, brk] (line content followed by break)
    /// - [linestart, text] (line marker followed by content)
    /// - [linestart, brk] (empty line before another line)
    /// - [linestart] alone (empty final line or empty buffer)
    /// - [brk, linestart, brk] (empty line between two lines, normalized from [brk, brk])
    ///
    /// These rules preserve linestart markers when deleting at col=0 within a line,
    /// since the deletion splits around the marker, and [text, linestart] only triggers
    /// when actually joining lines (deleting the break between them).
    pub fn rewriteBoundary(allocator: Allocator, left: ?*const Segment, right: ?*const Segment) !BoundaryAction {
        _ = allocator;

        if (left == null or right == null) return .{};

        const left_seg = left.?;
        const right_seg = right.?;

        // [linestart, linestart] -> delete right (dedup)
        if (left_seg.isLineStart() and right_seg.isLineStart()) {
            return .{ .delete_right = true };
        }

        // [brk, brk] -> insert linestart between (represents empty line)
        if (left_seg.isBreak() and right_seg.isBreak()) {
            const linestart_segment = Segment{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        // [brk, text] -> insert linestart between
        if (left_seg.isBreak() and right_seg.isText()) {
            const linestart_segment = Segment{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        // [text, linestart] -> delete right (remove orphaned linestart when joining lines)
        if (left_seg.isText() and right_seg.isLineStart()) {
            return .{ .delete_right = true };
        }

        return .{};
    }

    /// Rewrite rope ends to enforce invariants
    /// Rules:
    /// - Rope must start with linestart (even when empty - ensures at least one line)
    pub fn rewriteEnds(allocator: Allocator, first: ?*const Segment, last: ?*const Segment) !BoundaryAction {
        _ = allocator;
        _ = last;

        // Ensure rope starts with linestart (insert even if empty)
        if (first) |first_seg| {
            if (!first_seg.isLineStart()) {
                const linestart_segment = Segment{ .linestart = {} };
                const insert_slice = &[_]Segment{linestart_segment};
                return .{ .insert_between = insert_slice };
            }
        } else {
            // Empty rope - insert linestart to ensure at least one line
            const linestart_segment = Segment{ .linestart = {} };
            const insert_slice = &[_]Segment{linestart_segment};
            return .{ .insert_between = insert_slice };
        }

        return .{};
    }
};

pub const UnifiedRope = rope_mod.Rope(Segment);
