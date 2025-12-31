const std = @import("std");
const guardrails = @import("guardrails.zig");

/// Pass through a command to git CLI
pub fn run(allocator: std.mem.Allocator, args: [][:0]u8) !void {
    const stderr = std.fs.File.stderr().deprecatedWriter();

    // Check guardrails in agent mode
    if (guardrails.isAgentMode(allocator)) {
        // Cast to const for checkBlocked
        const const_args: []const [:0]const u8 = @ptrCast(args);
        if (guardrails.checkBlocked(const_args)) |reason| {
            // Build the command string for display
            var cmd_display: [256]u8 = undefined;
            var cmd_len: usize = 0;
            for (args) |arg| {
                const arg_slice = std.mem.sliceTo(arg, 0);
                if (cmd_len > 0 and cmd_len < cmd_display.len) {
                    cmd_display[cmd_len] = ' ';
                    cmd_len += 1;
                }
                const to_copy = @min(arg_slice.len, cmd_display.len - cmd_len);
                @memcpy(cmd_display[cmd_len..][0..to_copy], arg_slice[0..to_copy]);
                cmd_len += to_copy;
            }

            stderr.print("error: destructive command blocked (ZAGI_AGENT is set)\n", .{}) catch {};
            stderr.print("blocked: {s}\n", .{cmd_display[0..cmd_len]}) catch {};
            stderr.print("reason: {s}\n", .{reason}) catch {};
            std.process.exit(1);
        }
    }

    var git_args = std.array_list.Managed([]const u8).init(allocator);
    defer git_args.deinit();

    try git_args.append("git");
    for (args[1..]) |arg| {
        try git_args.append(arg);
    }

    var child = std.process.Child.init(git_args.items, allocator);
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;

    const term = child.spawnAndWait() catch |err| {
        stderr.print("Error executing git: {s}\n", .{@errorName(err)}) catch {};
        std.process.exit(1);
    };

    switch (term) {
        .Exited => |code| std.process.exit(code),
        .Signal => |sig| {
            stderr.print("Git terminated by signal {d}\n", .{sig}) catch {};
            std.process.exit(1);
        },
        .Stopped => |sig| {
            stderr.print("Git stopped by signal {d}\n", .{sig}) catch {};
            std.process.exit(1);
        },
        .Unknown => |code| {
            stderr.print("Git exited with unknown status {d}\n", .{code}) catch {};
            std.process.exit(1);
        },
    }
}
