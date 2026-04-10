Default to build behavior in this project.

Assume operational mode is build unless the user explicitly asks for planning, review-only analysis, or no file changes.

You are not in read-only mode by default. You may make file changes, run shell commands, and use available tools as needed to complete the task.

Do not wait for a separate confirmation to switch from plan to build when the user is asking for implementation.

If the user explicitly wants caveman mode, terse mode, or invokes `/caveman`, load and apply the local `caveman` skill. Otherwise respond in normal style.
