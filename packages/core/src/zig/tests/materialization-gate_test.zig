const std = @import("std");

fn assertNoMaterializedLayoutCall(source: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, source, "getLayoutSpansFor(") == null);
}

fn assertNoPattern(source: []const u8, pattern: []const u8) !void {
    try std.testing.expect(std.mem.indexOf(u8, source, pattern) == null);
}

test "runtime files do not call materialized layout spans API" {
    try assertNoMaterializedLayoutCall(@embedFile("../text-buffer-view.zig"));
    try assertNoMaterializedLayoutCall(@embedFile("../buffer.zig"));
    try assertNoMaterializedLayoutCall(@embedFile("../edit-buffer.zig"));
}

test "text-buffer-view does not include divergent wrap side paths" {
    const source = @embedFile("../text-buffer-view.zig");
    try assertNoPattern(source, "findWrapPosByWidth(");
    try assertNoPattern(source, "runWordWrapAscii(");
    try assertNoPattern(source, "calculateVirtualLineMetrics(");
}
