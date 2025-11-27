const std = @import("std");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Get command line arguments
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    // If no arguments provided (just the program name), show usage
    if (args.len < 2) {
        const stderr = std.io.getStdErr().writer();
        try stderr.print("usage: zagi <git-command> [args...]\n", .{});
        try stderr.print("\nzagi is a git wrapper that passes commands through to git.\n", .{});
        std.process.exit(1);
    }

    // Prepare arguments for git (skip our program name, prepend "git")
    var git_args = std.ArrayList([]const u8).init(allocator);
    defer git_args.deinit();

    try git_args.append("git");
    for (args[1..]) |arg| {
        try git_args.append(arg);
    }

    // Execute git command as a child process
    var child = std.process.Child.init(git_args.items, allocator);
    
    // Inherit stdin, stdout, and stderr so git can interact with the terminal
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;

    // Spawn and wait for the child process
    const term = child.spawnAndWait() catch |err| {
        const stderr = std.io.getStdErr().writer();
        try stderr.print("Error executing git: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    // Exit with the same code as git
    switch (term) {
        .Exited => |code| std.process.exit(code),
        .Signal => |sig| {
            const stderr = std.io.getStdErr().writer();
            try stderr.print("Git process terminated by signal {d}\n", .{sig});
            std.process.exit(1);
        },
        .Stopped => |sig| {
            const stderr = std.io.getStdErr().writer();
            try stderr.print("Git process stopped by signal {d}\n", .{sig});
            std.process.exit(1);
        },
        .Unknown => |code| {
            const stderr = std.io.getStdErr().writer();
            try stderr.print("Git process exited with unknown status {d}\n", .{code});
            std.process.exit(1);
        },
    }
}
