const std = @import("std");
const testing = std.testing;
const seg_mod = @import("../text-buffer-segment.zig");
const mem_registry_mod = @import("../mem-registry.zig");
const utf8 = @import("../utf8.zig");

const Segment = seg_mod.Segment;
const UnifiedRope = seg_mod.UnifiedRope;
const TextChunk = seg_mod.TextChunk;
const MemRegistry = mem_registry_mod.MemRegistry;

fn registerOwnedText(registry: *MemRegistry, text: []const u8) !u8 {
    const owned = try testing.allocator.dupe(u8, text);
    return try registry.register(owned, true);
}

fn makeChunk(mem_id: u8, text: []const u8, is_ascii: bool) TextChunk {
    const width = utf8.calculateTextWidth(text, 4, is_ascii, .unicode);
    return .{
        .mem_id = mem_id,
        .byte_start = 0,
        .byte_end = @intCast(text.len),
        .width = @intCast(@min(width, std.math.maxInt(u16))),
        .flags = if (is_ascii) TextChunk.Flags.ASCII_ONLY else 0,
    };
}

test "Segment.measure - text chunk" {
    const chunk = TextChunk{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 10,
        .width = 10,
        .flags = TextChunk.Flags.ASCII_ONLY,
    };
    const seg = Segment{ .text = chunk };
    const metrics = seg.measure();

    try testing.expectEqual(@as(u32, 10), metrics.total_width);
    try testing.expectEqual(@as(u32, 10), metrics.max_line_width);
    try testing.expect(metrics.ascii_only);
}

test "Segment.measure - break" {
    const seg = Segment{ .brk = {} };
    const metrics = seg.measure();

    try testing.expectEqual(@as(u32, 0), metrics.total_width);
    try testing.expectEqual(@as(u32, 0), metrics.max_line_width);
    try testing.expect(metrics.ascii_only);
}

test "Segment.empty and is_empty" {
    const seg = Segment.empty();
    try testing.expect(seg.is_empty());
}

test "Segment.isBreak and isText" {
    const text_seg = Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    };
    try testing.expect(text_seg.isText());
    try testing.expect(!text_seg.isBreak());

    const brk_seg = Segment{ .brk = {} };
    try testing.expect(brk_seg.isBreak());
    try testing.expect(!brk_seg.isText());
}

test "Segment.asText" {
    const chunk = TextChunk{
        .mem_id = 0,
        .byte_start = 0,
        .byte_end = 10,
        .width = 10,
        .flags = 0,
    };
    const text_seg = Segment{ .text = chunk };
    const retrieved = text_seg.asText();
    try testing.expect(retrieved != null);
    try testing.expectEqual(@as(u32, 10), retrieved.?.width);

    const brk_seg = Segment{ .brk = {} };
    try testing.expect(brk_seg.asText() == null);
}

test "Metrics.add - two text segments" {
    var left = Segment.Metrics{
        .total_width = 10,
        .max_line_width = 10,
        .ascii_only = true,
    };

    const right = Segment.Metrics{
        .total_width = 5,
        .max_line_width = 5,
        .ascii_only = true,
    };

    left.add(right);

    try testing.expectEqual(@as(u32, 15), left.total_width);
    try testing.expectEqual(@as(u32, 10), left.max_line_width);
    try testing.expect(left.ascii_only);
}

test "Metrics.add - text, break, text" {
    var left = Segment.Metrics{
        .total_width = 10,
        .max_line_width = 10,
        .ascii_only = true,
    };

    const middle = Segment.Metrics{
        .total_width = 0,
        .max_line_width = 0,
        .ascii_only = true,
    };

    left.add(middle);

    try testing.expectEqual(@as(u32, 10), left.total_width);
    try testing.expectEqual(@as(u32, 10), left.max_line_width);

    const right = Segment.Metrics{
        .total_width = 5,
        .max_line_width = 5,
        .ascii_only = true,
    };

    left.add(right);

    try testing.expectEqual(@as(u32, 15), left.total_width);
    try testing.expectEqual(@as(u32, 10), left.max_line_width);
}

test "Metrics.add - multiple breaks" {
    var metrics = Segment.Metrics{
        .total_width = 10,
        .max_line_width = 10,
        .ascii_only = true,
    };

    metrics.add(Segment.Metrics{
        .total_width = 0,
        .max_line_width = 0,
        .ascii_only = true,
    });

    metrics.add(Segment.Metrics{
        .total_width = 20,
        .max_line_width = 20,
        .ascii_only = true,
    });

    try testing.expectEqual(@as(u32, 30), metrics.total_width);
    try testing.expectEqual(@as(u32, 20), metrics.max_line_width);

    metrics.add(Segment.Metrics{
        .total_width = 0,
        .max_line_width = 0,
        .ascii_only = true,
    });

    metrics.add(Segment.Metrics{
        .total_width = 5,
        .max_line_width = 5,
        .ascii_only = true,
    });

    try testing.expectEqual(@as(u32, 35), metrics.total_width);
    try testing.expectEqual(@as(u32, 20), metrics.max_line_width);
}

test "Metrics.add - non-ASCII propagation" {
    var left = Segment.Metrics{
        .total_width = 10,
        .max_line_width = 10,
        .ascii_only = true,
    };

    const right = Segment.Metrics{
        .total_width = 5,
        .max_line_width = 5,
        .ascii_only = false,
    };

    left.add(right);
    try testing.expect(!left.ascii_only);
}

test "UnifiedRope - basic operations" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);

    const text1 = Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = TextChunk.Flags.ASCII_ONLY,
        },
    };
    try rope.append(text1);

    const brk = Segment{ .brk = {} };
    try rope.append(brk);

    const text2 = Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 15,
            .width = 5,
            .flags = TextChunk.Flags.ASCII_ONLY,
        },
    };
    try rope.append(text2);

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 5), rope.count());
    try testing.expectEqual(@as(u32, 15), metrics.custom.total_width);
    try testing.expectEqual(@as(u32, 10), metrics.custom.max_line_width);
}

test "UnifiedRope - empty rope metrics" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const rope = try UnifiedRope.init(allocator);
    const metrics = rope.root.metrics();

    try testing.expectEqual(@as(u32, 1), rope.count());
    try testing.expectEqual(@as(u32, 0), metrics.custom.total_width);
}

test "UnifiedRope - single text segment" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);
    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 20,
            .width = 20,
            .flags = 0,
        },
    });

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 2), rope.count());
    try testing.expectEqual(@as(u32, 20), metrics.custom.total_width);
    try testing.expectEqual(@as(u32, 20), metrics.custom.max_line_width);
}

test "UnifiedRope - multiple lines with varying widths" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var rope = try UnifiedRope.init(allocator);

    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 0,
            .byte_end = 10,
            .width = 10,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });

    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 10,
            .byte_end = 40,
            .width = 30,
            .flags = 0,
        },
    });
    try rope.append(Segment{ .brk = {} });

    try rope.append(Segment{
        .text = TextChunk{
            .mem_id = 0,
            .byte_start = 40,
            .byte_end = 55,
            .width = 15,
            .flags = 0,
        },
    });

    const metrics = rope.root.metrics();
    try testing.expectEqual(@as(u32, 8), rope.count());
    try testing.expectEqual(@as(u32, 55), metrics.custom.total_width);
    try testing.expectEqual(@as(u32, 30), metrics.custom.max_line_width);
}

fn combineMetrics(left: Segment.Metrics, right: Segment.Metrics) Segment.Metrics {
    var result = left;
    result.add(right);
    return result;
}

test "combineMetrics helper function" {
    const left = Segment.Metrics{
        .total_width = 10,
        .max_line_width = 10,
        .ascii_only = true,
    };

    const right = Segment.Metrics{
        .total_width = 5,
        .max_line_width = 5,
        .ascii_only = true,
    };

    const combined = combineMetrics(left, right);

    try testing.expectEqual(@as(u32, 15), combined.total_width);
    try testing.expectEqual(@as(u32, 10), combined.max_line_width);
    try testing.expect(combined.ascii_only);
}

test "TextChunk layout cache invalidates on tab width and width method" {
    seg_mod.setLayoutCacheModeOverrideForTesting(null);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    const text = "a\t👋🏻b";
    const mem_id = try registerOwnedText(&registry, text);
    var chunk = makeChunk(mem_id, text, false);

    const spans_tab2 = try chunk.getLayoutSpans(&registry, arena_alloc, 2, .unicode);
    const ptr_tab2 = @intFromPtr(spans_tab2.ptr);
    const tab2_width = spans_tab2[1].col_width;

    const spans_tab2_cached = try chunk.getLayoutSpans(&registry, arena_alloc, 2, .unicode);
    try testing.expectEqual(ptr_tab2, @intFromPtr(spans_tab2_cached.ptr));

    const spans_tab4 = try chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    const spans_tab4_cached = try chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(@intFromPtr(spans_tab4.ptr), @intFromPtr(spans_tab4_cached.ptr));
    try testing.expectEqual(@as(u16, 2), tab2_width);
    try testing.expectEqual(@as(u16, 4), spans_tab4[1].col_width);
    try testing.expectEqual(@as(u8, 4), chunk.layout_cache_tab_width);
    try testing.expectEqual(utf8.WidthMethod.unicode, chunk.layout_cache_width_method);

    const spans_wcwidth = try chunk.getLayoutSpans(&registry, arena_alloc, 4, .wcwidth);
    _ = spans_wcwidth;
    try testing.expectEqual(@as(u8, 4), chunk.layout_cache_tab_width);
    try testing.expectEqual(utf8.WidthMethod.wcwidth, chunk.layout_cache_width_method);
}

test "TextChunk ASCII threshold selects full-cache vs windowed" {
    seg_mod.setLayoutCacheModeOverrideForTesting(null);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    const small_text = try testing.allocator.alloc(u8, 256);
    defer testing.allocator.free(small_text);
    @memset(small_text, 'a');

    const small_mem_id = try registry.register(small_text, false);
    var small_chunk = makeChunk(small_mem_id, small_text, true);

    _ = try small_chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(seg_mod.LayoutCacheMode.full_cache, small_chunk.getLayoutCacheMode());
    try testing.expect(small_chunk.layout_cache_valid);
    try testing.expect(small_chunk.layout_spans != null);

    const large_text = try testing.allocator.alloc(u8, 1300);
    defer testing.allocator.free(large_text);
    @memset(large_text, 'a');

    const large_mem_id = try registry.register(large_text, false);
    var large_chunk = makeChunk(large_mem_id, large_text, true);

    _ = try large_chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(seg_mod.LayoutCacheMode.windowed, large_chunk.getLayoutCacheMode());
    try testing.expect(!large_chunk.layout_cache_valid);
    try testing.expect(large_chunk.layout_spans == null);
}

test "TextChunk non-ASCII threshold selects full-cache vs windowed" {
    seg_mod.setLayoutCacheModeOverrideForTesting(null);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    var full_builder: std.ArrayListUnmanaged(u8) = .{};
    defer full_builder.deinit(testing.allocator);
    for (0..585) |_| {
        try full_builder.appendSlice(testing.allocator, "가나a");
    }

    const full_text = try full_builder.toOwnedSlice(testing.allocator);
    defer testing.allocator.free(full_text);
    const full_mem_id = try registry.register(full_text, false);
    var full_chunk = makeChunk(full_mem_id, full_text, false);

    _ = try full_chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(seg_mod.LayoutCacheMode.full_cache, full_chunk.getLayoutCacheMode());
    try testing.expect(full_chunk.layout_cache_valid);

    var span_window_builder: std.ArrayListUnmanaged(u8) = .{};
    defer span_window_builder.deinit(testing.allocator);
    for (0..1500) |_| {
        try span_window_builder.appendSlice(testing.allocator, "a가");
    }

    const span_window_text = try span_window_builder.toOwnedSlice(testing.allocator);
    defer testing.allocator.free(span_window_text);
    const span_window_mem_id = try registry.register(span_window_text, false);
    var span_window_chunk = makeChunk(span_window_mem_id, span_window_text, false);

    _ = try span_window_chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(seg_mod.LayoutCacheMode.windowed, span_window_chunk.getLayoutCacheMode());
    try testing.expect(!span_window_chunk.layout_cache_valid);

    var bytes_window_builder: std.ArrayListUnmanaged(u8) = .{};
    defer bytes_window_builder.deinit(testing.allocator);
    for (0..3000) |_| {
        try bytes_window_builder.appendSlice(testing.allocator, "가");
    }

    const bytes_window_text = try bytes_window_builder.toOwnedSlice(testing.allocator);
    defer testing.allocator.free(bytes_window_text);
    const bytes_window_mem_id = try registry.register(bytes_window_text, false);
    var bytes_window_chunk = makeChunk(bytes_window_mem_id, bytes_window_text, false);

    _ = try bytes_window_chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    try testing.expectEqual(seg_mod.LayoutCacheMode.windowed, bytes_window_chunk.getLayoutCacheMode());
    try testing.expect(!bytes_window_chunk.layout_cache_valid);
}

test "TextChunk windowed layout spans match full-cache spans" {
    defer seg_mod.setLayoutCacheModeOverrideForTesting(null);

    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    var registry = MemRegistry.init(testing.allocator);
    defer registry.deinit();

    var text_builder: std.ArrayListUnmanaged(u8) = .{};
    defer text_builder.deinit(testing.allocator);
    for (0..900) |_| {
        try text_builder.appendSlice(testing.allocator, "ab👋🏻가나\t");
    }

    const text = try text_builder.toOwnedSlice(testing.allocator);
    defer testing.allocator.free(text);

    const mem_id = try registry.register(text, false);
    var chunk = makeChunk(mem_id, text, false);

    seg_mod.setLayoutCacheModeOverrideForTesting(.full_cache);
    const full_spans = try chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);
    const full_spans_copy = try testing.allocator.dupe(utf8.GraphemeSpan, full_spans);
    defer testing.allocator.free(full_spans_copy);

    seg_mod.setLayoutCacheModeOverrideForTesting(.windowed);
    const windowed_spans = try chunk.getLayoutSpans(&registry, arena_alloc, 4, .unicode);

    try testing.expectEqual(seg_mod.LayoutCacheMode.windowed, chunk.getLayoutCacheMode());
    try testing.expectEqual(full_spans_copy.len, windowed_spans.len);
    try testing.expectEqualSlices(utf8.GraphemeSpan, full_spans_copy, windowed_spans);
}
