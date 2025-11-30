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
        try stderr.print("Special commands:\n", .{});
        try stderr.print("  diff - Uses difftastic for better diffs, shows one file at a time\n", .{});
        std.process.exit(1);
    }

    // Check if this is the special "diff" command
    if (std.mem.eql(u8, args[1], "diff")) {
        try handleDiffCommand(allocator, args);
        return;
    }

    // For all other commands, pass through to git
    try passThrough(allocator, args);
}

fn handleDiffCommand(allocator: std.mem.Allocator, args: [][]const u8) !void {
    const stdout = std.io.getStdOut().writer();
    const stderr = std.io.getStdErr().writer();

    // Check if difftastic is installed
    const difftastic_check = std.process.Child.init(&[_][]const u8{ "which", "difft" }, allocator);
    const difft_available = blk: {
        var check_child = difftastic_check;
        check_child.stdout_behavior = .Ignore;
        check_child.stderr_behavior = .Ignore;
        const term = check_child.spawnAndWait() catch break :blk false;
        break :blk switch (term) {
            .Exited => |code| code == 0,
            else => false,
        };
    };

    // If difftastic is not available, fall back to regular git diff
    if (!difft_available) {
        try stderr.print("difftastic not found, falling back to git diff\n", .{});
        try stderr.print("Install difftastic with: brew install difftastic (or your package manager)\n\n", .{});
        try passThrough(allocator, args);
        return;
    }

    // Build difftastic command with remaining arguments
    var difft_args = std.ArrayList([]const u8).init(allocator);
    defer difft_args.deinit();

    try difft_args.append("difft");
    
    // Add difftastic-specific options for better output
    try difft_args.append("--color=always");
    try difft_args.append("--display=inline");
    
    // Build git diff command to pipe to difftastic
    var git_args = std.ArrayList([]const u8).init(allocator);
    defer git_args.deinit();
    
    try git_args.append("git");
    try git_args.append("diff");
    
    // Add user's additional arguments
    for (args[2..]) |arg| {
        try git_args.append(arg);
    }

    // Get the full diff output from git
    var git_child = std.process.Child.init(git_args.items, allocator);
    git_child.stdout_behavior = .Pipe;
    git_child.stderr_behavior = .Inherit;
    
    try git_child.spawn();
    
    const git_output = try git_child.stdout.?.readToEndAlloc(allocator, 100 * 1024 * 1024); // 100MB max
    defer allocator.free(git_output);
    
    _ = try git_child.wait();

    // If no diff output, exit early
    if (git_output.len == 0) {
        try stdout.print("No changes to diff\n", .{});
        return;
    }

    // Run difftastic on the git output
    var difft_child = std.process.Child.init(difft_args.items, allocator);
    difft_child.stdin_behavior = .Pipe;
    difft_child.stdout_behavior = .Pipe;
    difft_child.stderr_behavior = .Inherit;
    
    try difft_child.spawn();
    
    // Write git output to difftastic stdin
    try difft_child.stdin.?.writeAll(git_output);
    difft_child.stdin.?.close();
    difft_child.stdin = null;
    
    const difft_output = try difft_child.stdout.?.readToEndAlloc(allocator, 100 * 1024 * 1024); // 100MB max
    defer allocator.free(difft_output);
    
    _ = try difft_child.wait();

    // Parse output to extract first file only
    try showFirstFileOnly(stdout, difft_output, args[2..]);
}

fn showFirstFileOnly(writer: anytype, output: []const u8, original_args: [][]const u8) !void {
    // Split output into lines
    var line_iter = std.mem.split(u8, output, "\n");
    var current_file: ?[]const u8 = null;
    var file_count: usize = 0;
    var lines_printed: usize = 0;
    var in_first_file = false;
    
    // Look for file separators in difftastic output
    // Difftastic typically shows files with a separator like "path/to/file"
    while (line_iter.next()) |line| {
        // Detect new file (difftastic shows file paths prominently)
        // This is a simplified heuristic - adjust based on actual difftastic output format
        if (line.len > 0 and !std.mem.startsWith(u8, line, " ") and 
            !std.mem.startsWith(u8, line, "+") and !std.mem.startsWith(u8, line, "-") and
            !std.mem.startsWith(u8, line, "@") and
            (std.mem.indexOf(u8, line, "/") != null or std.mem.endsWith(u8, line, ".zig") or 
             std.mem.endsWith(u8, line, ".rs") or std.mem.endsWith(u8, line, ".go") or
             std.mem.endsWith(u8, line, ".js") or std.mem.endsWith(u8, line, ".ts") or
             std.mem.endsWith(u8, line, ".py") or std.mem.endsWith(u8, line, ".c") or
             std.mem.endsWith(u8, line, ".cpp") or std.mem.endsWith(u8, line, ".h"))) {
            
            if (current_file == null) {
                current_file = line;
                in_first_file = true;
                file_count = 1;
            } else if (in_first_file) {
                // Found second file, stop here
                file_count = 2;
                break;
            }
        }
        
        if (in_first_file) {
            try writer.print("{s}\n", .{line});
            lines_printed += 1;
        }
    }

    // If we didn't detect multiple files using the heuristic, just show all output
    if (file_count == 0) {
        try writer.print("{s}\n", .{output});
        return;
    }

    // Add recipe command if there are more files
    if (file_count > 1 or lines_printed > 100) {
        try writer.print("\n{s}\n", .{"=" ** 80});
        try writer.print("📝 Recipe: To see the next file, run:\n", .{});
        try writer.print("  ", .{});
        
        if (current_file) |file| {
            // Suggest showing just the next file using git diff with path
            try writer.print("git diff", .{});
            for (original_args) |arg| {
                try writer.print(" {s}", .{arg});
            }
            try writer.print(" -- <next-file>\n", .{});
        } else {
            try writer.print("zagi diff", .{});
            for (original_args) |arg| {
                try writer.print(" {s}", .{arg});
            }
            try writer.print(" -- <file-path>\n", .{});
        }
        
        try writer.print("\nOr see all files with: git diff", .{});
        for (original_args) |arg| {
            try writer.print(" {s}", .{arg});
        }
        try writer.print("\n", .{});
    }
}

fn passThrough(allocator: std.mem.Allocator, args: [][]const u8) !void {
    const stderr = std.io.getStdErr().writer();
    
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
        try stderr.print("Error executing git: {s}\n", .{@errorName(err)});
        std.process.exit(1);
    };

    // Exit with the same code as git
    switch (term) {
        .Exited => |code| std.process.exit(code),
        .Signal => |sig| {
            try stderr.print("Git process terminated by signal {d}\n", .{sig});
            std.process.exit(1);
        },
        .Stopped => |sig| {
            try stderr.print("Git process stopped by signal {d}\n", .{sig});
            std.process.exit(1);
        },
        .Unknown => |code| {
            try stderr.print("Git process exited with unknown status {d}\n", .{code});
            std.process.exit(1);
        },
    }
}
