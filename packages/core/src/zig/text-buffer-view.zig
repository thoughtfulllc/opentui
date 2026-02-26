const std = @import("std");
const Allocator = std.mem.Allocator;
const tb = @import("text-buffer.zig");
const seg_mod = @import("text-buffer-segment.zig");
const iter_mod = @import("text-buffer-iterators.zig");
const gp = @import("grapheme.zig");
const utf8 = @import("utf8.zig");

const logger = @import("logger.zig");

const UnifiedTextBuffer = tb.UnifiedTextBuffer;
const RGBA = tb.RGBA;
const TextSelection = tb.TextSelection;
pub const WrapMode = tb.WrapMode;
const TextChunk = seg_mod.TextChunk;
const StyleSpan = tb.StyleSpan;

pub const TextBufferViewError = error{
    OutOfMemory,
};

/// Viewport defines a rectangular window into the virtual line space
pub const Viewport = struct {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
};

pub const LineInfo = struct {
    starts: []const u32,
    widths: []const u32,
    sources: []const u32,
    wraps: []const u32,
    max_width: u32,
};

pub const WrapInfo = struct {
    line_first_vline: []const u32,
    line_vline_counts: []const u32,
};

/// Output structure for virtual line calculation
pub const VirtualLineOutput = struct {
    virtual_lines: *std.ArrayListUnmanaged(VirtualLine),
    cached_line_starts: *std.ArrayListUnmanaged(u32),
    cached_line_widths: *std.ArrayListUnmanaged(u32),
    cached_line_sources: *std.ArrayListUnmanaged(u32),
    cached_line_wrap_indices: *std.ArrayListUnmanaged(u32),
    cached_line_first_vline: *std.ArrayListUnmanaged(u32),
    cached_line_vline_counts: *std.ArrayListUnmanaged(u32),
};

/// Result from measuring dimensions without modifying cache
pub const MeasureResult = struct {
    line_count: u32,
    max_width: u32,
};

pub const VirtualLineSpanInfo = struct {
    spans: []const StyleSpan,
    source_line: usize,
    col_offset: u32,
};

pub const VirtualChunk = struct {
    chunk: *const TextChunk,
    byte_start_in_chunk: u32,
    byte_len: u32,
    col_start_in_chunk: u32,
    width_cols: u32,
};

pub const VirtualLine = struct {
    chunks: std.ArrayListUnmanaged(VirtualChunk),
    width: u32,
    char_offset: u32,
    source_line: usize,
    source_col_offset: u32,
    is_truncated: bool,
    ellipsis_pos: u32,
    truncation_suffix_start: u32,

    pub fn init() VirtualLine {
        return .{
            .chunks = .{},
            .width = 0,
            .char_offset = 0,
            .source_line = 0,
            .source_col_offset = 0,
            .is_truncated = false,
            .ellipsis_pos = 0,
            .truncation_suffix_start = 0,
        };
    }

    pub fn deinit(self: *VirtualLine, allocator: Allocator) void {
        self.chunks.deinit(allocator);
    }
};

pub const LocalSelection = struct {
    anchorX: i32,
    anchorY: i32,
    focusX: i32,
    focusY: i32,
    isActive: bool,
};

pub const TextBufferView = UnifiedTextBufferView;

pub const UnifiedTextBufferView = struct {
    const Self = @This();

    text_buffer: *UnifiedTextBuffer,
    original_text_buffer: *UnifiedTextBuffer,
    view_id: u32,
    selection: ?TextSelection,
    selection_anchor_offset: ?u32,
    viewport: ?Viewport,
    wrap_width: ?u32,
    wrap_mode: WrapMode,
    virtual_lines: std.ArrayListUnmanaged(VirtualLine),
    virtual_lines_dirty: bool,
    cached_line_starts: std.ArrayListUnmanaged(u32),
    cached_line_widths: std.ArrayListUnmanaged(u32),
    cached_line_sources: std.ArrayListUnmanaged(u32),
    cached_line_wrap_indices: std.ArrayListUnmanaged(u32),
    cached_line_first_vline: std.ArrayListUnmanaged(u32),
    cached_line_vline_counts: std.ArrayListUnmanaged(u32),
    global_allocator: Allocator,
    virtual_lines_arena: *std.heap.ArenaAllocator,

    /// Persistent arena for measureForDimensions. Each call resets it with
    /// retain_capacity to avoid mmap/munmap churn during streaming.
    measure_arena: std.heap.ArenaAllocator,
    tab_indicator: ?u32,
    tab_indicator_color: ?RGBA,
    truncate: bool,
    ellipsis_chunk: TextChunk,
    ellipsis_mem_id: u8,

    // Measurement cache for Yoga layout. Keyed by (buffer, epoch, width, wrap_mode).
    // Using epoch instead of dirty flag prevents stale returns when unrelated
    // code paths clear dirty (e.g., updateVirtualLines).
    cached_measure_width: ?u32,
    cached_measure_wrap_mode: WrapMode,
    cached_measure_result: ?MeasureResult,
    cached_measure_epoch: u64,
    cached_measure_buffer: ?*UnifiedTextBuffer,

    truncation_applied: bool,
    truncation_epoch: u64,
    truncation_viewport: ?Viewport,

    pub fn init(global_allocator: Allocator, text_buffer: *UnifiedTextBuffer) TextBufferViewError!*Self {
        const self = global_allocator.create(Self) catch return TextBufferViewError.OutOfMemory;
        errdefer global_allocator.destroy(self);

        const virtual_lines_internal_arena = global_allocator.create(std.heap.ArenaAllocator) catch return TextBufferViewError.OutOfMemory;
        errdefer global_allocator.destroy(virtual_lines_internal_arena);
        virtual_lines_internal_arena.* = std.heap.ArenaAllocator.init(global_allocator);

        const view_id = text_buffer.registerView() catch return TextBufferViewError.OutOfMemory;

        const ellipsis_text = "...";
        const ellipsis_mem_id = text_buffer.registerMemBuffer(ellipsis_text, false) catch return TextBufferViewError.OutOfMemory;
        const ellipsis_chunk = text_buffer.createChunk(ellipsis_mem_id, 0, 3);

        self.* = .{
            .text_buffer = text_buffer,
            .original_text_buffer = text_buffer,
            .view_id = view_id,
            .selection = null,
            .selection_anchor_offset = null,
            .viewport = null,
            .wrap_width = null,
            .wrap_mode = .none,
            .virtual_lines = .{},
            .virtual_lines_dirty = true,
            .cached_line_starts = .{},
            .cached_line_widths = .{},
            .cached_line_sources = .{},
            .cached_line_wrap_indices = .{},
            .cached_line_first_vline = .{},
            .cached_line_vline_counts = .{},
            .global_allocator = global_allocator,
            .virtual_lines_arena = virtual_lines_internal_arena,
            .measure_arena = std.heap.ArenaAllocator.init(global_allocator),
            .tab_indicator = null,
            .tab_indicator_color = null,
            .truncate = false,
            .ellipsis_chunk = ellipsis_chunk,
            .ellipsis_mem_id = ellipsis_mem_id,
            .cached_measure_width = null,
            .cached_measure_wrap_mode = .none,
            .cached_measure_result = null,
            .cached_measure_epoch = 0,
            .cached_measure_buffer = null,
            .truncation_applied = false,
            .truncation_epoch = 0,
            .truncation_viewport = null,
        };

        return self;
    }

    /// IMPORTANT: Views must be destroyed BEFORE their associated TextBuffer.
    /// Destroying the TextBuffer first will cause use-after-free when calling deinit.
    /// The TypeScript wrappers enforce this order via the destroy() methods.
    pub fn deinit(self: *Self) void {
        self.original_text_buffer.unregisterView(self.view_id);
        self.virtual_lines_arena.deinit();
        self.global_allocator.destroy(self.virtual_lines_arena);
        self.measure_arena.deinit();
        self.global_allocator.destroy(self);
    }

    pub fn setViewport(self: *Self, vp: ?Viewport) void {
        self.viewport = vp;

        // If viewport has width, set wrap width (wrapping behavior depends on wrap_mode)
        if (vp) |viewport| {
            if (self.wrap_width != viewport.width) {
                self.wrap_width = viewport.width;
                self.virtual_lines_dirty = true;
                self.truncation_applied = false;
            }
        } else {
            self.truncation_applied = false;
        }
    }

    pub fn getViewport(self: *const Self) ?Viewport {
        return self.viewport;
    }

    // This is a convenience method that preserves existing offset
    pub fn setViewportSize(self: *Self, width: u32, height: u32) void {
        if (self.viewport) |vp| {
            self.setViewport(Viewport{
                .x = vp.x,
                .y = vp.y,
                .width = width,
                .height = height,
            });
        } else {
            self.setViewport(Viewport{
                .x = 0,
                .y = 0,
                .width = width,
                .height = height,
            });
        }
    }

    pub fn setWrapWidth(self: *Self, width: ?u32) void {
        if (self.wrap_width != width) {
            self.wrap_width = width;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    pub fn setWrapMode(self: *Self, mode: WrapMode) void {
        if (self.wrap_mode != mode) {
            self.wrap_mode = mode;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    fn calculateChunkFitWord(self: *const Self, chunk: *const TextChunk, char_offset_in_chunk: u32, max_width: u32) tb.ChunkFitResult {
        if (max_width == 0) return .{ .char_count = 0, .width = 0 };

        const total_width = @as(u32, chunk.width) - char_offset_in_chunk;
        if (total_width == 0) return .{ .char_count = 0, .width = 0 };
        if (total_width <= max_width) return .{ .char_count = total_width, .width = total_width };

        const wrap_offsets = self.text_buffer.getWrapOffsetsFor(chunk) catch {
            const fit_width = @min(max_width, total_width);
            return .{ .char_count = fit_width, .width = fit_width };
        };

        var last_boundary: ?u32 = null;
        var first_boundary: ?u32 = null;

        for (wrap_offsets) |wrap_break| {
            const offset = @as(u32, wrap_break.char_offset);
            if (offset < char_offset_in_chunk) continue;

            const local_offset = offset - char_offset_in_chunk;
            if (local_offset >= total_width) break;

            const width_to_boundary = local_offset + 1;
            if (first_boundary == null) first_boundary = width_to_boundary;

            if (width_to_boundary <= max_width) {
                last_boundary = width_to_boundary;
            } else break;
        }

        if (last_boundary) |width| return .{ .char_count = width, .width = width };

        const line_width = self.wrap_width orelse max_width;
        const needs_force_break = (first_boundary orelse total_width) > line_width;

        if (needs_force_break) {
            const fit_width = @min(max_width, total_width);
            return .{ .char_count = fit_width, .width = fit_width };
        }

        return .{ .char_count = 0, .width = 0 };
    }

    pub fn updateVirtualLines(self: *Self) void {
        const buffer_dirty = self.text_buffer.isViewDirty(self.view_id);
        if (!self.virtual_lines_dirty and !buffer_dirty) return;

        _ = self.virtual_lines_arena.reset(.free_all);
        self.virtual_lines = .{};
        self.cached_line_starts = .{};
        self.cached_line_widths = .{};
        self.cached_line_sources = .{};
        self.cached_line_wrap_indices = .{};
        self.cached_line_first_vline = .{};
        self.cached_line_vline_counts = .{};
        self.truncation_applied = false;
        const virtual_allocator = self.virtual_lines_arena.allocator();

        // Create output structure for the generic function
        const output = VirtualLineOutput{
            .virtual_lines = &self.virtual_lines,
            .cached_line_starts = &self.cached_line_starts,
            .cached_line_widths = &self.cached_line_widths,
            .cached_line_sources = &self.cached_line_sources,
            .cached_line_wrap_indices = &self.cached_line_wrap_indices,
            .cached_line_first_vline = &self.cached_line_first_vline,
            .cached_line_vline_counts = &self.cached_line_vline_counts,
        };

        // Call the generic calculation function
        calculateVirtualLinesGeneric(
            self.text_buffer,
            self.wrap_mode,
            self.wrap_width,
            virtual_allocator,
            output,
        );

        self.virtual_lines_dirty = false;
        self.text_buffer.clearViewDirty(self.view_id);
    }

    pub fn getVirtualLineCount(self: *Self) u32 {
        self.updateVirtualLines();
        return @intCast(self.virtual_lines.items.len);
    }

    pub fn getVirtualLines(self: *Self) []const VirtualLine {
        self.updateVirtualLines();

        const all_vlines = self.virtual_lines.items;

        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        if (self.viewport) |vp| {
            const start_idx = @min(vp.y, @as(u32, @intCast(all_vlines.len)));
            const end_idx = @min(start_idx + vp.height, @as(u32, @intCast(all_vlines.len)));
            return all_vlines[start_idx..end_idx];
        }

        return all_vlines;
    }

    pub fn getCachedLineInfo(self: *Self) LineInfo {
        self.updateVirtualLines();

        // If viewport is set, return only the visible lines' info
        if (self.viewport) |vp| {
            const start_idx = @min(vp.y, @as(u32, @intCast(self.cached_line_starts.items.len)));
            const end_idx = @min(start_idx + vp.height, @as(u32, @intCast(self.cached_line_starts.items.len)));

            const viewport_starts = self.cached_line_starts.items[start_idx..end_idx];
            const viewport_widths = self.cached_line_widths.items[start_idx..end_idx];
            const viewport_sources = self.cached_line_sources.items[start_idx..end_idx];
            const viewport_wraps = self.cached_line_wrap_indices.items[start_idx..end_idx];

            var max_width: u32 = 0;
            for (viewport_widths) |w| {
                max_width = @max(max_width, w);
            }

            return LineInfo{
                .starts = viewport_starts,
                .widths = viewport_widths,
                .sources = viewport_sources,
                .wraps = viewport_wraps,
                .max_width = max_width,
            };
        }

        return LineInfo{
            .starts = self.cached_line_starts.items,
            .widths = self.cached_line_widths.items,
            .sources = self.cached_line_sources.items,
            .wraps = self.cached_line_wrap_indices.items,
            .max_width = self.text_buffer.maxLineWidth(),
        };
    }

    pub fn getLogicalLineInfo(self: *Self) LineInfo {
        self.updateVirtualLines();

        return LineInfo{
            .starts = self.cached_line_starts.items,
            .widths = self.cached_line_widths.items,
            .sources = self.cached_line_sources.items,
            .wraps = self.cached_line_wrap_indices.items,
            .max_width = self.text_buffer.maxLineWidth(),
        };
    }

    pub fn getWrapInfo(self: *Self) WrapInfo {
        self.updateVirtualLines();
        return WrapInfo{
            .line_first_vline = self.cached_line_first_vline.items,
            .line_vline_counts = self.cached_line_vline_counts.items,
        };
    }

    pub fn findVisualLineIndex(self: *Self, logical_row: u32, logical_col: u32) u32 {
        self.updateVirtualLines();

        const vlines = self.virtual_lines.items;
        if (vlines.len == 0) return 0;

        const wrap_info = self.getWrapInfo();

        // Clamp logical_row to valid range
        const clamped_row = if (logical_row >= wrap_info.line_first_vline.len)
            if (wrap_info.line_first_vline.len > 0) wrap_info.line_first_vline.len - 1 else 0
        else
            logical_row;

        if (clamped_row >= wrap_info.line_first_vline.len) return 0;

        const first_vline_idx = wrap_info.line_first_vline[clamped_row];
        const vline_count = wrap_info.line_vline_counts[clamped_row];

        if (vline_count == 0) return first_vline_idx;

        var i: u32 = 0;
        while (i < vline_count) : (i += 1) {
            const vline_idx = first_vline_idx + i;
            if (vline_idx >= vlines.len) break;

            const vline = &vlines[vline_idx];
            const vline_start_col = vline.source_col_offset;
            const vline_end_col = vline_start_col + vline.width;

            const is_last_vline = (i == vline_count - 1);

            // For the end check: use < for all lines except the last line where we use <=
            // This ensures that a position exactly at vline_end_col goes to the NEXT line
            // unless this is the last line (where there is no next line)
            const end_check = if (is_last_vline) logical_col <= vline_end_col else logical_col < vline_end_col;

            if (logical_col >= vline_start_col and end_check) {
                return vline_idx;
            }
        }

        // If not found, return last virtual line for this logical line
        const last_vline_idx = first_vline_idx + vline_count - 1;
        if (last_vline_idx < vlines.len) {
            return last_vline_idx;
        }

        return first_vline_idx;
    }

    pub fn getPlainTextIntoBuffer(self: *const Self, out_buffer: []u8) usize {
        return self.text_buffer.getPlainTextIntoBuffer(out_buffer);
    }

    pub fn getArenaAllocatedBytes(self: *const Self) usize {
        return self.virtual_lines_arena.queryCapacity();
    }

    pub fn setSelection(self: *Self, start: u32, end: u32, bgColor: ?RGBA, fgColor: ?RGBA) void {
        self.selection = TextSelection{
            .start = start,
            .end = end,
            .bgColor = bgColor,
            .fgColor = fgColor,
        };
    }

    pub fn updateSelection(self: *Self, end: u32, bgColor: ?RGBA, fgColor: ?RGBA) void {
        if (self.selection) |sel| {
            self.selection = TextSelection{
                .start = sel.start,
                .end = end,
                .bgColor = bgColor,
                .fgColor = fgColor,
            };
        }
    }

    pub fn resetSelection(self: *Self) void {
        self.selection = null;
    }

    pub fn getSelection(self: *const Self) ?TextSelection {
        return self.selection;
    }

    pub fn getTextBuffer(self: *const Self) *UnifiedTextBuffer {
        return self.text_buffer;
    }

    pub fn switchToBuffer(self: *Self, buffer: *UnifiedTextBuffer) void {
        self.text_buffer = buffer;
        self.virtual_lines_dirty = true;
    }

    pub fn switchToOriginalBuffer(self: *Self) void {
        if (self.text_buffer != self.original_text_buffer) {
            self.text_buffer = self.original_text_buffer;
            self.virtual_lines_dirty = true;
        }
    }

    pub fn setLocalSelection(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA) bool {
        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        const anchor_above = anchorY < 0;
        const focus_above = focusY < 0;
        const max_y = @as(i32, @intCast(self.virtual_lines.items.len)) - 1;
        const anchor_below = anchorY > max_y;
        const focus_below = focusY > max_y;

        if ((anchor_above and focus_above) or (anchor_below and focus_below)) {
            const had_selection = self.selection != null;
            self.selection = null;
            self.selection_anchor_offset = null;
            return had_selection;
        }

        const text_end_offset = self.getTextEndOffset();

        const anchor_offset = if (anchor_above or anchorX < 0)
            0
        else if (anchor_below)
            text_end_offset
        else
            self.coordsToCharOffset(anchorX, anchorY) orelse {
                const had_selection = self.selection != null;
                self.selection = null;
                self.selection_anchor_offset = null;
                return had_selection;
            };

        const focus_offset = if (focus_above or focusX < 0)
            0
        else if (focus_below)
            text_end_offset
        else
            self.coordsToCharOffset(focusX, focusY) orelse {
                const had_selection = self.selection != null;
                self.selection = null;
                self.selection_anchor_offset = null;
                return had_selection;
            };

        self.selection_anchor_offset = anchor_offset;

        const new_start = @min(anchor_offset, focus_offset);
        const new_end = @max(anchor_offset, focus_offset);

        // Always store selection, even if zero-width, to preserve anchor for updateLocalSelection
        const new_selection = TextSelection{
            .start = new_start,
            .end = new_end,
            .bgColor = bgColor,
            .fgColor = fgColor,
        };

        const selection_changed = if (self.selection) |old_sel|
            old_sel.start != new_selection.start or old_sel.end != new_selection.end
        else
            true;

        self.selection = new_selection;
        return selection_changed;
    }

    pub fn updateLocalSelection(self: *Self, anchorX: i32, anchorY: i32, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA) bool {
        if (self.selection_anchor_offset) |_| {
            return self.updateLocalSelectionFocusOnly(focusX, focusY, bgColor, fgColor);
        } else {
            return self.setLocalSelection(anchorX, anchorY, focusX, focusY, bgColor, fgColor);
        }
    }

    fn updateLocalSelectionFocusOnly(self: *Self, focusX: i32, focusY: i32, bgColor: ?RGBA, fgColor: ?RGBA) bool {
        const anchor_offset = self.selection_anchor_offset orelse return false;

        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.applyTruncation();
        }

        const focus_above = focusY < 0;
        const max_y = @as(i32, @intCast(self.virtual_lines.items.len)) - 1;
        const focus_below = focusY > max_y;

        const text_end_offset = self.getTextEndOffset();

        const focus_char_offset = if (focus_above or focusX < 0)
            0
        else if (focus_below)
            text_end_offset
        else
            self.coordsToCharOffset(focusX, focusY) orelse return false;

        const new_start = @min(anchor_offset, focus_char_offset);
        var new_end = @max(anchor_offset, focus_char_offset);

        if (focus_char_offset < anchor_offset) {
            new_end = @min(new_end + 1, text_end_offset);
        }

        self.selection = TextSelection{
            .start = new_start,
            .end = new_end,
            .bgColor = bgColor,
            .fgColor = fgColor,
        };

        return true;
    }

    pub fn resetLocalSelection(self: *Self) void {
        self.selection = null;
        self.selection_anchor_offset = null;
    }

    fn getTextEndOffset(self: *Self) u32 {
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        if (self.virtual_lines.items.len == 0) return 0;
        const last_line_idx = self.virtual_lines.items.len - 1;
        const last_vline = &self.virtual_lines.items[last_line_idx];

        if (last_vline.is_truncated) {
            return last_vline.char_offset + last_vline.truncation_suffix_start + (last_vline.width - last_vline.ellipsis_pos - 3);
        }

        return last_vline.char_offset + last_vline.width;
    }

    fn coordsToCharOffset(self: *Self, x: i32, y: i32) ?u32 {
        self.updateVirtualLines();
        if (self.truncate and self.viewport != null) {
            self.ensureTruncation();
        }

        const y_offset: i32 = if (self.viewport) |vp| @intCast(vp.y) else 0;
        const x_offset: i32 = if (self.viewport) |vp|
            (if (self.wrap_mode == .none) @intCast(vp.x) else 0)
        else
            0;

        if (self.virtual_lines.items.len == 0) {
            return 0;
        }

        const abs_y = y + y_offset;
        const abs_x = x + x_offset;

        const clamped_y = @max(0, @min(abs_y, @as(i32, @intCast(self.virtual_lines.items.len)) - 1));

        const vline_idx: usize = @intCast(clamped_y);
        const vline = &self.virtual_lines.items[vline_idx];
        const lineStart = vline.char_offset;
        const lineWidth = vline.width;

        var localX = @max(0, @min(abs_x, @as(i32, @intCast(lineWidth))));

        if (vline.is_truncated) {
            const ellipsis_width: u32 = 3;
            const localX_u32: u32 = @intCast(localX);

            if (localX_u32 >= vline.ellipsis_pos and localX_u32 < vline.ellipsis_pos + ellipsis_width) {
                localX = @intCast(vline.ellipsis_pos);
            } else if (localX_u32 >= vline.ellipsis_pos + ellipsis_width) {
                const suffix_offset = localX_u32 - vline.ellipsis_pos - ellipsis_width;
                localX = @intCast(vline.truncation_suffix_start + suffix_offset);
            }
        }

        const result = lineStart + @as(u32, @intCast(localX));

        return result;
    }

    /// Pack selection info into u64 for efficient passing
    /// Returns 0xFFFF_FFFF_FFFF_FFFF for no selection or zero-width selection
    pub fn packSelectionInfo(self: *const Self) u64 {
        if (self.selection) |sel| {
            if (sel.start == sel.end) {
                return 0xFFFF_FFFF_FFFF_FFFF;
            }
            return (@as(u64, sel.start) << 32) | @as(u64, sel.end);
        } else {
            return 0xFFFF_FFFF_FFFF_FFFF;
        }
    }

    /// Get selected text into buffer - using efficient single-pass API
    pub fn getSelectedTextIntoBuffer(self: *Self, out_buffer: []u8) usize {
        const selection = self.selection orelse return 0;
        if (selection.start == selection.end) return 0;
        return self.text_buffer.getTextRange(selection.start, selection.end, out_buffer);
    }

    pub fn getVirtualLineSpans(self: *const Self, vline_idx: usize) VirtualLineSpanInfo {
        if (vline_idx >= self.virtual_lines.items.len) {
            return VirtualLineSpanInfo{ .spans = &[_]StyleSpan{}, .source_line = 0, .col_offset = 0 };
        }

        const vline = &self.virtual_lines.items[vline_idx];
        const spans = self.text_buffer.getLineSpans(vline.source_line);

        return VirtualLineSpanInfo{
            .spans = spans,
            .source_line = vline.source_line,
            .col_offset = vline.source_col_offset,
        };
    }

    pub fn setTabIndicator(self: *Self, indicator: ?u32) void {
        self.tab_indicator = indicator;
    }

    pub fn getTabIndicator(self: *const Self) ?u32 {
        return self.tab_indicator;
    }

    pub fn setTabIndicatorColor(self: *Self, color: ?RGBA) void {
        self.tab_indicator_color = color;
    }

    pub fn getTabIndicatorColor(self: *const Self) ?RGBA {
        return self.tab_indicator_color;
    }

    pub fn setTruncate(self: *Self, truncate: bool) void {
        if (self.truncate != truncate) {
            self.truncate = truncate;
            self.virtual_lines_dirty = true;
            self.truncation_applied = false;
        }
    }

    pub fn getTruncate(self: *const Self) bool {
        return self.truncate;
    }

    fn ensureTruncation(self: *Self) void {
        if (!self.truncate or self.viewport == null) return;

        const epoch = self.text_buffer.getContentEpoch();
        if (self.truncation_applied and self.truncation_epoch == epoch and
            self.truncation_viewport != null and self.viewport != null and
            self.truncation_viewport.?.x == self.viewport.?.x and
            self.truncation_viewport.?.y == self.viewport.?.y and
            self.truncation_viewport.?.width == self.viewport.?.width and
            self.truncation_viewport.?.height == self.viewport.?.height)
        {
            return;
        }

        self.applyTruncation();
        self.truncation_applied = true;
        self.truncation_epoch = epoch;
        self.truncation_viewport = self.viewport;
    }

    const TruncationSliceResult = struct {
        width_added: u32,
        first_col_in_line: ?u32,
    };

    fn appendOrExtendChunkWindow(self: *Self, out_chunks: *std.ArrayListUnmanaged(VirtualChunk), chunk: VirtualChunk) TruncationSliceResult {
        if (chunk.byte_len == 0) {
            return .{ .width_added = 0, .first_col_in_line = null };
        }

        if (out_chunks.items.len > 0) {
            const last_idx = out_chunks.items.len - 1;
            const last = &out_chunks.items[last_idx];
            if (last.chunk == chunk.chunk and
                last.byte_start_in_chunk + last.byte_len == chunk.byte_start_in_chunk and
                last.col_start_in_chunk + last.width_cols == chunk.col_start_in_chunk)
            {
                last.byte_len += chunk.byte_len;
                last.width_cols += chunk.width_cols;
            } else {
                out_chunks.append(self.virtual_lines_arena.allocator(), chunk) catch {
                    return .{ .width_added = 0, .first_col_in_line = null };
                };
            }
        } else {
            out_chunks.append(self.virtual_lines_arena.allocator(), chunk) catch {
                return .{ .width_added = 0, .first_col_in_line = null };
            };
        }

        return .{
            .width_added = chunk.width_cols,
            .first_col_in_line = null,
        };
    }

    fn appendChunkSliceByLineCols(
        self: *Self,
        out_chunks: *std.ArrayListUnmanaged(VirtualChunk),
        source_chunk: VirtualChunk,
        line_chunk_start_col: u32,
        range_start_col: u32,
        range_end_col: u32,
    ) TruncationSliceResult {
        const line_chunk_end_col = line_chunk_start_col + source_chunk.width_cols;
        const clamped_start_col = @max(range_start_col, line_chunk_start_col);
        const clamped_end_col = @min(range_end_col, line_chunk_end_col);
        if (clamped_start_col >= clamped_end_col) {
            return .{ .width_added = 0, .first_col_in_line = null };
        }

        const local_start_col = source_chunk.col_start_in_chunk + (clamped_start_col - line_chunk_start_col);
        const local_end_col = source_chunk.col_start_in_chunk + (clamped_end_col - line_chunk_start_col);

        const source_byte_start = source_chunk.byte_start_in_chunk;
        const source_byte_end = source_chunk.byte_start_in_chunk + source_chunk.byte_len;

        const stable_allocator = self.text_buffer.getAllocator();
        const spans = self.text_buffer.getLayoutSpansFor(source_chunk.chunk, stable_allocator) catch {
            return .{ .width_added = 0, .first_col_in_line = null };
        };
        const free_windowed_spans = source_chunk.chunk.getLayoutCacheMode() == .windowed;
        defer if (free_windowed_spans) {
            stable_allocator.free(@constCast(spans));
        };

        var slice_byte_start: ?u32 = null;
        var slice_byte_end: u32 = 0;
        var slice_col_start: ?u32 = null;
        var slice_col_end: u32 = 0;

        for (spans) |span| {
            const span_byte_start = span.byte_start;
            const span_byte_end = span.byte_start + span.byte_len;
            if (span_byte_end <= source_byte_start) continue;
            if (span_byte_start >= source_byte_end) break;

            const span_col_start = span.col_start;
            const span_col_end = span.col_start + span.col_width;

            // Keep only full-span boundaries for truncation windows.
            if (span_col_start < local_start_col or span_col_end > local_end_col) {
                continue;
            }

            if (slice_byte_start == null) {
                slice_byte_start = span_byte_start;
                slice_col_start = span_col_start;
            }
            slice_byte_end = span_byte_end;
            slice_col_end = span_col_end;
        }

        if (slice_byte_start == null or slice_col_start == null) {
            return .{ .width_added = 0, .first_col_in_line = null };
        }

        const first_col_in_line = line_chunk_start_col + (slice_col_start.? - source_chunk.col_start_in_chunk);
        const chunk_window = VirtualChunk{
            .chunk = source_chunk.chunk,
            .byte_start_in_chunk = slice_byte_start.?,
            .byte_len = slice_byte_end - slice_byte_start.?,
            .col_start_in_chunk = slice_col_start.?,
            .width_cols = slice_col_end - slice_col_start.?,
        };

        var append_result = self.appendOrExtendChunkWindow(out_chunks, chunk_window);
        append_result.first_col_in_line = first_col_in_line;
        return append_result;
    }

    fn applyTruncation(self: *Self) void {
        const vp = self.viewport orelse return;
        if (vp.width == 0) return;

        const ellipsis_width: u32 = 3;

        for (self.virtual_lines.items) |*vline| {
            if (vline.width <= vp.width) continue;

            if (vp.width <= ellipsis_width) {
                vline.chunks.clearRetainingCapacity();
                vline.width = 0;
                vline.is_truncated = true;
                vline.ellipsis_pos = 0;
                vline.truncation_suffix_start = vline.width;
                continue;
            }

            const available_width = vp.width - ellipsis_width;
            const prefix_width = available_width / 2;
            const suffix_width = available_width - prefix_width;
            const suffix_start_target = vline.width - suffix_width;

            var new_chunks: std.ArrayListUnmanaged(VirtualChunk) = .{};

            var prefix_accumulated: u32 = 0;
            var chunk_line_col: u32 = 0;
            for (vline.chunks.items) |chunk| {
                if (prefix_accumulated >= prefix_width) break;

                const added = self.appendChunkSliceByLineCols(
                    &new_chunks,
                    chunk,
                    chunk_line_col,
                    0,
                    prefix_width,
                );
                prefix_accumulated += added.width_added;
                chunk_line_col += chunk.width_cols;
            }

            new_chunks.append(self.virtual_lines_arena.allocator(), VirtualChunk{
                .chunk = &self.ellipsis_chunk,
                .byte_start_in_chunk = 0,
                .byte_len = self.ellipsis_chunk.byte_end - self.ellipsis_chunk.byte_start,
                .col_start_in_chunk = 0,
                .width_cols = ellipsis_width,
            }) catch return;

            var suffix_accumulated: u32 = 0;
            var suffix_first_col: ?u32 = null;
            chunk_line_col = 0;
            for (vline.chunks.items) |chunk| {
                const added = self.appendChunkSliceByLineCols(
                    &new_chunks,
                    chunk,
                    chunk_line_col,
                    suffix_start_target,
                    vline.width,
                );
                if (added.width_added > 0 and suffix_first_col == null) {
                    suffix_first_col = added.first_col_in_line;
                }
                suffix_accumulated += added.width_added;
                chunk_line_col += chunk.width_cols;
            }

            vline.chunks.clearRetainingCapacity();
            vline.chunks.appendSlice(self.virtual_lines_arena.allocator(), new_chunks.items) catch return;
            vline.width = prefix_accumulated + ellipsis_width + suffix_accumulated;
            vline.is_truncated = true;
            vline.ellipsis_pos = prefix_accumulated;
            vline.truncation_suffix_start = suffix_first_col orelse suffix_start_target;
        }
    }

    /// Measure dimensions for given width/height WITHOUT modifying virtual lines cache
    /// This is useful for Yoga measure functions that need to know dimensions without committing changes
    /// Special case: width=0 or wrap_mode=.none means "measure intrinsic/max-content width" (no wrapping)
    pub fn measureForDimensions(self: *Self, width: u32, height: u32) TextBufferViewError!MeasureResult {
        _ = height; // Height is for future use, currently only width affects layout
        const epoch = self.text_buffer.getContentEpoch();
        if (self.cached_measure_result) |result| {
            if (self.cached_measure_epoch == epoch and self.cached_measure_buffer == self.text_buffer) {
                if (self.cached_measure_width) |cached_width| {
                    if (cached_width == width and self.cached_measure_wrap_mode == self.wrap_mode) {
                        return result;
                    }
                }
            }
        }

        // No-wrap path avoids allocations by using marker-based line widths.
        if (width == 0 or self.wrap_mode == .none) {
            const line_count = self.text_buffer.lineCount();
            var max_width: u32 = 0;
            var row: u32 = 0;
            while (row < line_count) : (row += 1) {
                max_width = @max(max_width, self.text_buffer.lineWidthAt(row));
            }

            const result = MeasureResult{
                .line_count = line_count,
                .max_width = max_width,
            };

            self.cached_measure_width = width;
            self.cached_measure_wrap_mode = self.wrap_mode;
            self.cached_measure_result = result;
            self.cached_measure_epoch = epoch;
            self.cached_measure_buffer = self.text_buffer;

            return result;
        }

        // Reuse arena capacity to avoid allocation overhead during streaming.
        _ = self.measure_arena.reset(.retain_capacity);
        const measure_allocator = self.measure_arena.allocator();

        // Create temporary output structures
        var temp_virtual_lines = std.ArrayListUnmanaged(VirtualLine){};
        var temp_line_starts = std.ArrayListUnmanaged(u32){};
        var temp_line_widths = std.ArrayListUnmanaged(u32){};
        var temp_line_sources = std.ArrayListUnmanaged(u32){};
        var temp_line_wrap_indices = std.ArrayListUnmanaged(u32){};
        var temp_line_first_vline = std.ArrayListUnmanaged(u32){};
        var temp_line_vline_counts = std.ArrayListUnmanaged(u32){};

        const output = VirtualLineOutput{
            .virtual_lines = &temp_virtual_lines,
            .cached_line_starts = &temp_line_starts,
            .cached_line_widths = &temp_line_widths,
            .cached_line_sources = &temp_line_sources,
            .cached_line_wrap_indices = &temp_line_wrap_indices,
            .cached_line_first_vline = &temp_line_first_vline,
            .cached_line_vline_counts = &temp_line_vline_counts,
        };

        // Use width for wrap calculation
        const wrap_width_for_measure = if (self.wrap_mode != .none and width > 0) width else null;

        // Call generic calculation with temporary structures
        calculateVirtualLinesGeneric(
            self.text_buffer,
            self.wrap_mode,
            wrap_width_for_measure,
            measure_allocator,
            output,
        );

        // Calculate max width from temp structures
        var max_width: u32 = 0;
        for (temp_line_widths.items) |w| {
            max_width = @max(max_width, w);
        }

        const result = MeasureResult{
            .line_count = @intCast(temp_virtual_lines.items.len),
            .max_width = max_width,
        };

        self.cached_measure_width = width;
        self.cached_measure_wrap_mode = self.wrap_mode;
        self.cached_measure_result = result;
        self.cached_measure_epoch = epoch;
        self.cached_measure_buffer = self.text_buffer;

        return result;
    }

    /// Generic virtual line calculation that writes to provided output structures
    fn calculateVirtualLinesGeneric(
        text_buffer: *UnifiedTextBuffer,
        wrap_mode: WrapMode,
        wrap_width: ?u32,
        allocator: Allocator,
        output: VirtualLineOutput,
    ) void {
        const BreakByteResolver = struct {
            fn infer(buffer: *UnifiedTextBuffer, line_info: iter_mod.LineInfo) u32 {
                const rope = buffer.rope();
                if (line_info.seg_end >= rope.count()) {
                    return 0;
                }

                const break_seg = rope.get(line_info.seg_end) orelse return 0;
                if (!break_seg.isBreak()) {
                    return 0;
                }

                var seg_idx = line_info.seg_end;
                while (seg_idx > line_info.seg_start) {
                    seg_idx -= 1;
                    const seg = rope.get(seg_idx) orelse break;
                    if (seg.asText()) |chunk| {
                        const mem = buffer.memRegistry().get(chunk.mem_id) orelse return 1;
                        const break_pos: usize = @intCast(chunk.byte_end);
                        if (break_pos >= mem.len) {
                            return 1;
                        }

                        const b0 = mem[break_pos];
                        if (b0 == '\r') {
                            if (break_pos + 1 < mem.len and mem[break_pos + 1] == '\n') {
                                return 2;
                            }
                            return 1;
                        }

                        if (b0 == '\n') {
                            return 1;
                        }

                        return 1;
                    }
                }

                return 1;
            }
        };

        if (wrap_mode == .none or wrap_width == null) {
            // No wrapping - create 1:1 mapping to real lines
            const Context = struct {
                text_buffer: *UnifiedTextBuffer,
                allocator: Allocator,
                output: VirtualLineOutput,
                current_vline: ?VirtualLine = null,
                global_byte_offset: u32 = 0,
                line_start_byte_offset: u32 = 0,

                fn segment_callback(ctx_ptr: *anyopaque, _line_idx: u32, chunk: *const TextChunk, _: u32) void {
                    _ = _line_idx;
                    const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

                    if (ctx.current_vline) |*vline| {
                        vline.chunks.append(ctx.allocator, VirtualChunk{
                            .chunk = chunk,
                            .byte_start_in_chunk = 0,
                            .byte_len = chunk.byte_end - chunk.byte_start,
                            .col_start_in_chunk = 0,
                            .width_cols = chunk.width,
                        }) catch {};
                    }

                    ctx.global_byte_offset += chunk.byte_end - chunk.byte_start;
                }

                fn line_end_callback(ctx_ptr: *anyopaque, line_info: iter_mod.LineInfo) void {
                    const ctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

                    const first_vline_idx: u32 = @intCast(ctx.output.virtual_lines.items.len);
                    ctx.output.cached_line_first_vline.append(ctx.allocator, first_vline_idx) catch {};
                    ctx.output.cached_line_vline_counts.append(ctx.allocator, 1) catch {};

                    var vline = if (ctx.current_vline) |v| v else VirtualLine.init();
                    vline.width = line_info.width;
                    vline.char_offset = line_info.char_offset;
                    vline.source_line = line_info.line_idx;
                    vline.source_col_offset = 0;

                    ctx.output.virtual_lines.append(ctx.allocator, vline) catch {};
                    ctx.output.cached_line_starts.append(ctx.allocator, ctx.line_start_byte_offset) catch {};
                    ctx.output.cached_line_widths.append(ctx.allocator, vline.width) catch {};
                    ctx.output.cached_line_sources.append(ctx.allocator, @intCast(line_info.line_idx)) catch {};
                    ctx.output.cached_line_wrap_indices.append(ctx.allocator, 0) catch {};

                    ctx.current_vline = VirtualLine.init();
                    ctx.global_byte_offset += BreakByteResolver.infer(ctx.text_buffer, line_info);
                    ctx.line_start_byte_offset = ctx.global_byte_offset;
                }
            };

            var ctx = Context{
                .text_buffer = text_buffer,
                .allocator = allocator,
                .output = output,
                .current_vline = VirtualLine.init(),
            };

            text_buffer.walkLinesAndSegments(&ctx, Context.segment_callback, Context.line_end_callback);
        } else {
            const wrap_w = wrap_width.?;

            const WrapContext = struct {
                text_buffer: *UnifiedTextBuffer,
                allocator: Allocator,
                output: VirtualLineOutput,
                wrap_mode: WrapMode,
                wrap_w: u32,
                global_byte_offset: u32 = 0,
                global_col_offset: u32 = 0,
                line_start_byte_offset: u32 = 0,
                line_idx: u32 = 0,
                line_col_offset: u32 = 0,
                line_position: u32 = 0,
                current_vline: VirtualLine = VirtualLine.init(),
                current_line_first_vline_idx: u32 = 0,
                current_line_vline_count: u32 = 0,

                current_chunk_wrap_breaks: std.ArrayListUnmanaged(bool) = .{},

                last_wrap_chunk_count: u32 = 0,
                last_wrap_line_position: u32 = 0,
                last_wrap_global_col_offset: u32 = 0,
                last_wrap_global_byte_offset: u32 = 0,

                fn clearLastWrap(wctx: *@This()) void {
                    wctx.last_wrap_chunk_count = 0;
                    wctx.last_wrap_line_position = 0;
                    wctx.last_wrap_global_col_offset = 0;
                    wctx.last_wrap_global_byte_offset = 0;
                }

                fn rememberLastWrap(wctx: *@This()) void {
                    wctx.last_wrap_chunk_count = @as(u32, @intCast(wctx.current_vline.chunks.items.len));
                    wctx.last_wrap_line_position = wctx.line_position;
                    wctx.last_wrap_global_col_offset = wctx.global_col_offset;
                    wctx.last_wrap_global_byte_offset = wctx.global_byte_offset;
                }

                fn canExtendLastChunk(wctx: *@This(), chunk: *const TextChunk, span: utf8.GraphemeSpan) bool {
                    if (wctx.current_vline.chunks.items.len == 0) return false;

                    const last_idx = wctx.current_vline.chunks.items.len - 1;
                    if (wctx.current_chunk_wrap_breaks.items[last_idx]) return false;

                    const last_chunk = wctx.current_vline.chunks.items[last_idx];
                    if (last_chunk.chunk != chunk) return false;

                    return last_chunk.col_start_in_chunk + last_chunk.width_cols == span.col_start and
                        last_chunk.byte_start_in_chunk + last_chunk.byte_len == span.byte_start;
                }

                fn appendSpanChunk(wctx: *@This(), chunk: *const TextChunk, span: utf8.GraphemeSpan, track_wrap_breaks: bool) void {
                    const span_width: u32 = span.col_width;
                    const span_byte_len: u32 = span.byte_len;
                    const has_wrap_break = track_wrap_breaks and span.break_after != .none;
                    var should_remember_wrap = false;

                    if (wctx.canExtendLastChunk(chunk, span)) {
                        const last_idx = wctx.current_vline.chunks.items.len - 1;
                        wctx.current_vline.chunks.items[last_idx].width_cols += span_width;
                        wctx.current_vline.chunks.items[last_idx].byte_len += span_byte_len;
                        if (has_wrap_break) {
                            wctx.current_chunk_wrap_breaks.items[last_idx] = true;
                            should_remember_wrap = true;
                        }
                    } else {
                        const previous_len = wctx.current_vline.chunks.items.len;
                        wctx.current_vline.chunks.append(wctx.allocator, VirtualChunk{
                            .chunk = chunk,
                            .byte_start_in_chunk = span.byte_start,
                            .byte_len = span_byte_len,
                            .col_start_in_chunk = span.col_start,
                            .width_cols = span_width,
                        }) catch {};

                        if (wctx.current_vline.chunks.items.len == previous_len + 1) {
                            wctx.current_chunk_wrap_breaks.append(wctx.allocator, has_wrap_break) catch {
                                wctx.current_vline.chunks.items.len = previous_len;
                            };

                            if (has_wrap_break and wctx.current_chunk_wrap_breaks.items.len == previous_len + 1) {
                                should_remember_wrap = true;
                            }
                        }
                    }

                    wctx.global_byte_offset += span_byte_len;
                    wctx.global_col_offset += span_width;
                    wctx.line_position += span_width;

                    if (should_remember_wrap) {
                        wctx.rememberLastWrap();
                    }
                }

                fn consumeDroppedSpan(wctx: *@This(), span: utf8.GraphemeSpan) void {
                    wctx.global_byte_offset += span.byte_len;
                    wctx.global_col_offset += span.col_width;
                    wctx.line_col_offset += span.col_width;
                    wctx.line_start_byte_offset += span.byte_len;
                    wctx.current_vline.char_offset = wctx.global_col_offset;
                    wctx.clearLastWrap();
                }

                fn commitVirtualLine(wctx: *@This()) void {
                    if (wctx.current_vline.chunks.items.len > 1) {
                        var write_idx: usize = 0;
                        var read_idx: usize = 1;
                        while (read_idx < wctx.current_vline.chunks.items.len) : (read_idx += 1) {
                            const next_chunk = wctx.current_vline.chunks.items[read_idx];
                            var merged = false;

                            {
                                const current_chunk = &wctx.current_vline.chunks.items[write_idx];
                                if (current_chunk.chunk == next_chunk.chunk and
                                    current_chunk.col_start_in_chunk + current_chunk.width_cols == next_chunk.col_start_in_chunk and
                                    current_chunk.byte_start_in_chunk + current_chunk.byte_len == next_chunk.byte_start_in_chunk)
                                {
                                    current_chunk.width_cols += next_chunk.width_cols;
                                    current_chunk.byte_len += next_chunk.byte_len;
                                    merged = true;
                                }
                            }

                            if (!merged) {
                                write_idx += 1;
                                if (write_idx != read_idx) {
                                    wctx.current_vline.chunks.items[write_idx] = next_chunk;
                                }
                            }
                        }

                        wctx.current_vline.chunks.items.len = write_idx + 1;
                    }

                    wctx.current_vline.width = wctx.line_position;
                    wctx.current_vline.source_line = wctx.line_idx;
                    wctx.current_vline.source_col_offset = wctx.line_col_offset;
                    wctx.output.virtual_lines.append(wctx.allocator, wctx.current_vline) catch {};
                    wctx.output.cached_line_starts.append(wctx.allocator, wctx.line_start_byte_offset) catch {};
                    wctx.output.cached_line_widths.append(wctx.allocator, wctx.current_vline.width) catch {};
                    wctx.output.cached_line_sources.append(wctx.allocator, wctx.line_idx) catch {};
                    wctx.output.cached_line_wrap_indices.append(wctx.allocator, wctx.current_line_vline_count) catch {};

                    wctx.current_line_vline_count += 1;

                    wctx.line_col_offset += wctx.line_position;
                    wctx.line_start_byte_offset = wctx.global_byte_offset;
                    wctx.current_vline = VirtualLine.init();
                    wctx.current_vline.char_offset = wctx.global_col_offset;
                    wctx.line_position = 0;

                    wctx.current_chunk_wrap_breaks.clearRetainingCapacity();

                    wctx.clearLastWrap();
                }

                fn rewindToLastWrap(wctx: *@This()) bool {
                    if (wctx.last_wrap_chunk_count == 0) {
                        return false;
                    }

                    const wrap_chunk_count: usize = @intCast(wctx.last_wrap_chunk_count);
                    if (wrap_chunk_count > wctx.current_vline.chunks.items.len) {
                        wctx.clearLastWrap();
                        return false;
                    }

                    const suffix_chunks = wctx.current_vline.chunks.items[wrap_chunk_count..];
                    const suffix_wrap_breaks = wctx.current_chunk_wrap_breaks.items[wrap_chunk_count..];

                    wctx.current_vline.chunks.items.len = wrap_chunk_count;
                    wctx.current_chunk_wrap_breaks.items.len = wrap_chunk_count;
                    wctx.line_position = wctx.last_wrap_line_position;
                    wctx.global_col_offset = wctx.last_wrap_global_col_offset;
                    wctx.global_byte_offset = wctx.last_wrap_global_byte_offset;

                    wctx.commitVirtualLine();

                    var moved_idx: usize = 0;
                    while (moved_idx < suffix_chunks.len) : (moved_idx += 1) {
                        const moved_chunk = suffix_chunks[moved_idx];
                        const moved_has_wrap_break = suffix_wrap_breaks[moved_idx];

                        const previous_len = wctx.current_vline.chunks.items.len;
                        wctx.current_vline.chunks.append(wctx.allocator, moved_chunk) catch continue;
                        wctx.current_chunk_wrap_breaks.append(wctx.allocator, moved_has_wrap_break) catch {
                            wctx.current_vline.chunks.items.len = previous_len;
                            continue;
                        };

                        wctx.global_byte_offset += moved_chunk.byte_len;
                        wctx.global_col_offset += moved_chunk.width_cols;
                        wctx.line_position += moved_chunk.width_cols;

                        if (moved_has_wrap_break) {
                            wctx.rememberLastWrap();
                        }
                    }

                    return true;
                }

                fn runWordWrap(wctx: *@This(), chunk: *const TextChunk, spans: []const utf8.GraphemeSpan) void {
                    var span_idx: usize = 0;
                    while (span_idx < spans.len) {
                        const span = spans[span_idx];
                        const span_width: u32 = span.col_width;
                        const fits = wctx.line_position + span_width <= wctx.wrap_w;

                        if (fits) {
                            wctx.appendSpanChunk(chunk, span, true);
                            span_idx += 1;
                            continue;
                        }

                        if (wctx.line_position == 0) {
                            wctx.appendSpanChunk(chunk, span, true);
                            span_idx += 1;
                            wctx.commitVirtualLine();
                            continue;
                        }

                        if (span.break_after == .whitespace) {
                            wctx.commitVirtualLine();
                            wctx.consumeDroppedSpan(span);
                            span_idx += 1;
                            continue;
                        }

                        if (wctx.rewindToLastWrap()) {
                            continue;
                        }

                        wctx.commitVirtualLine();
                    }
                }

                fn runCharWrap(wctx: *@This(), chunk: *const TextChunk, spans: []const utf8.GraphemeSpan) void {
                    var span_idx: usize = 0;
                    while (span_idx < spans.len) {
                        const span = spans[span_idx];
                        const span_width: u32 = span.col_width;
                        const fits = wctx.line_position + span_width <= wctx.wrap_w;

                        if (fits) {
                            wctx.appendSpanChunk(chunk, span, false);
                            span_idx += 1;
                            continue;
                        }

                        if (wctx.line_position == 0) {
                            wctx.appendSpanChunk(chunk, span, false);
                            span_idx += 1;
                            wctx.commitVirtualLine();
                            continue;
                        }

                        wctx.commitVirtualLine();
                    }
                }

                fn segment_callback(ctx_ptr: *anyopaque, _line_idx: u32, chunk: *const TextChunk, _chunk_idx_in_line: u32) void {
                    _ = _line_idx;
                    _ = _chunk_idx_in_line;
                    const wctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

                    const stable_allocator = wctx.text_buffer.getAllocator();
                    const spans = wctx.text_buffer.getLayoutSpansFor(chunk, stable_allocator) catch {
                        return;
                    };

                    const free_windowed_spans = chunk.getLayoutCacheMode() == .windowed;
                    defer if (free_windowed_spans) {
                        stable_allocator.free(@constCast(spans));
                    };

                    if (wctx.wrap_mode == .word) {
                        wctx.runWordWrap(chunk, spans);
                    } else {
                        wctx.runCharWrap(chunk, spans);
                    }
                }

                fn line_end_callback(ctx_ptr: *anyopaque, line_info: iter_mod.LineInfo) void {
                    const wctx = @as(*@This(), @ptrCast(@alignCast(ctx_ptr)));

                    if (wctx.current_vline.chunks.items.len > 0 or line_info.width == 0) {
                        wctx.commitVirtualLine();
                    }

                    wctx.output.cached_line_first_vline.append(wctx.allocator, wctx.current_line_first_vline_idx) catch {};
                    wctx.output.cached_line_vline_counts.append(wctx.allocator, wctx.current_line_vline_count) catch {};

                    wctx.global_col_offset += 1;
                    wctx.global_byte_offset += BreakByteResolver.infer(wctx.text_buffer, line_info);

                    wctx.line_idx += 1;
                    wctx.line_col_offset = 0;
                    wctx.line_position = 0;
                    wctx.line_start_byte_offset = wctx.global_byte_offset;
                    wctx.current_vline = VirtualLine.init();
                    wctx.current_vline.char_offset = wctx.global_col_offset;
                    wctx.current_line_first_vline_idx = @intCast(wctx.output.virtual_lines.items.len);
                    wctx.current_line_vline_count = 0;

                    wctx.current_chunk_wrap_breaks.clearRetainingCapacity();
                    wctx.clearLastWrap();
                }
            };

            var wrap_ctx = WrapContext{
                .text_buffer = text_buffer,
                .allocator = allocator,
                .output = output,
                .wrap_mode = wrap_mode,
                .wrap_w = wrap_w,
            };

            text_buffer.walkLinesAndSegments(&wrap_ctx, WrapContext.segment_callback, WrapContext.line_end_callback);
        }
    }
};
